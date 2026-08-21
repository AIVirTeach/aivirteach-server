import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { CourseContentService } from "../content/course-content.service";
import { DatabaseRepository } from "../data/database-repository";
import { ChatMessage, Enrollment } from "../data/models";
import { LabsService } from "../labs/labs.service";
import { LabsAgentClient, LabsAgentHistoryMessage, LabsAgentRequest } from "./labs-agent.client";

const MAX_AGENT_HISTORY_MESSAGES = 8;
const MAX_AGENT_HISTORY_MESSAGE_LENGTH = 2_000;
const MAX_CHAT_THREAD_ID_LENGTH = 512;
const DEFAULT_GUEST_WORKSPACE_ROOT = "/home/learner/course";

const COMMON_DIAGNOSTIC_TOOLS = [
  "get_vm_status",
  "get_guest_agent_status",
  "get_guest_journal",
  "get_guest_service_status",
  "get_guest_network_summary",
  "get_guest_listening_ports",
  "check_guest_port",
  "check_guest_dns",
  "list_course_files",
  "stat_course_file",
  "read_course_file",
  "tail_course_file",
  "list_guest_containers",
  "get_guest_container_status",
  "get_guest_container_logs",
  "get_guest_container_ports",
];

const COURSE_DIAGNOSTIC_RESOURCES: Record<string, {
  containers: string[];
  ports: number[];
  externalHosts: string[];
}> = {
  "ai-daily-briefing": {
    containers: ["n8n"],
    ports: [5678],
    externalHosts: [
      "api.tavily.com",
      "generativelanguage.googleapis.com",
      "oauth2.googleapis.com",
      "gmail.googleapis.com",
    ],
  },
  "ai-web-watcher-agent": {
    containers: ["ai-web-watcher-n8n", "ai-web-watcher-testsite"],
    ports: [5678],
    externalHosts: [
      "generativelanguage.googleapis.com",
      "oauth2.googleapis.com",
      "gmail.googleapis.com",
    ],
  },
};

type CourseDetails = ReturnType<CourseContentService["getCourse"]>;
type CurrentCourseStep = {
  module: CourseDetails["modules"][number];
  lesson: CourseDetails["modules"][number]["lessons"][number];
  sequence: number;
};

type SelectedCourseContext = {
  courseId?: string;
  lessonId?: string;
};

@Injectable()
export class ChatService {
  constructor(
    @Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository,
    private readonly content: CourseContentService,
    private readonly labs: LabsService,
    private readonly agent: LabsAgentClient,
  ) {}

  async list(userId: string, threadId: string) {
    this.assertOwnedThread(userId, threadId);
    return this.db.listChatMessages(userId, threadId);
  }

  async send(userId: string, threadId: string, text: string, selected: SelectedCourseContext = {}) {
    this.assertOwnedThread(userId, threadId);
    const question = text.trim();
    if (!question) throw new BadRequestException("Chat message cannot be empty");
    if (!await this.db.findUser(userId)) throw new NotFoundException("Learner not found");

    const enrollment = await this.db.activeEnrollment(userId);
    if (!enrollment) throw new NotFoundException("No active course enrollment");
    if (selected.courseId && selected.courseId !== enrollment.courseId) {
      throw new BadRequestException("The selected course is not the learner's active enrollment");
    }
    const course = this.content.getCourse(enrollment.courseId);
    const currentStep = this.currentCourseStep(course, enrollment, selected.lessonId);
    const labId = this.labs.assignedLabId(userId);
    const history = this.agentHistory(await this.db.listChatMessages(userId, threadId));

    const studentMessage: ChatMessage = {
      id: `message_${crypto.randomUUID()}`,
      userId,
      threadId,
      role: "student",
      text: question,
      provider: null,
      createdAt: new Date().toISOString(),
    };
    await this.db.saveChatMessages([studentMessage]);

    const diagnosis = await this.agent.diagnose(this.agentRequest({
      labId,
      text: question,
      course,
      currentStep,
      enrollment,
      threadId,
      history,
    }));

    const tutorMessage: ChatMessage = {
      id: `message_${crypto.randomUUID()}`,
      userId,
      threadId,
      role: "tutor",
      text: diagnosis.answer,
      provider: "labs-agent",
      createdAt: new Date().toISOString(),
    };
    await this.db.saveChatMessages([tutorMessage]);
    return { studentMessage, tutorMessage, provider: "labs-agent" };
  }

  private assertOwnedThread(userId: string, threadId: string) {
    const prefix = `chat:v1:${encodeURIComponent(userId)}:`;
    if (!threadId.startsWith(prefix) || threadId.length === prefix.length || threadId.length > MAX_CHAT_THREAD_ID_LENGTH) {
      throw new BadRequestException("Chat thread does not belong to the current learner");
    }
  }

  private currentCourseStep(course: CourseDetails, enrollment: Enrollment, selectedLessonId?: string): CurrentCourseStep {
    const lessons = course.modules.flatMap((module) => module.lessons.map((lesson) => ({ module, lesson })));
    if (!lessons.length) throw new ServiceUnavailableException("The active course has no diagnosable lessons");
    if (selectedLessonId) {
      const selectedIndex = lessons.findIndex(({ lesson }) => lesson.id === selectedLessonId);
      if (selectedIndex < 0) throw new BadRequestException("The selected lesson does not belong to the active course");
      return { ...lessons[selectedIndex], sequence: selectedIndex + 1 };
    }
    const progress = Math.min(100, Math.max(0, enrollment.progressPercent));
    // Keep this derivation aligned with the client's fallback lesson selection.
    const completedLessons = Math.floor((progress / 100) * lessons.length);
    const index = Math.min(completedLessons, lessons.length - 1);
    return { ...lessons[index], sequence: index + 1 };
  }

  private agentHistory(messages: ChatMessage[]): LabsAgentHistoryMessage[] {
    return messages
      .filter((message) => message.text.trim())
      .slice(-MAX_AGENT_HISTORY_MESSAGES)
      .map((message) => ({
        role: message.role === "student" ? "user" : "assistant",
        content: message.text.slice(0, MAX_AGENT_HISTORY_MESSAGE_LENGTH),
      }));
  }

  private agentRequest(input: {
    labId: string;
    text: string;
    course: CourseDetails;
    currentStep: CurrentCourseStep;
    enrollment: Enrollment;
    threadId: string;
    history: LabsAgentHistoryMessage[];
  }): LabsAgentRequest {
    const { course, currentStep, enrollment } = input;
    const resources = COURSE_DIAGNOSTIC_RESOURCES[course.id];
    const instructions = [currentStep.lesson.activity.prompt, ...currentStep.lesson.objectives].filter(Boolean).slice(0, 20);
    return {
      request_id: crypto.randomUUID(),
      lab_id: input.labId,
      question: input.text,
      response_language: /[\u3400-\u9fff]/u.test(input.text) ? "zh-CN" : (course.language || "en"),
      course: {
        course_id: course.id,
        version: course.version,
        title: course.title,
        summary: course.description,
      },
      current_step: {
        module_id: currentStep.module.id,
        lesson_id: currentStep.lesson.id,
        sequence: currentStep.sequence,
        title: currentStep.lesson.title,
        summary: currentStep.module.description,
        instructions,
        expected_result: currentStep.lesson.activity.prompt,
        success_criteria: currentStep.lesson.objectives.slice(0, 20),
      },
      learner_state: {
        currentLessonId: currentStep.lesson.id,
        progressPercent: enrollment.progressPercent,
        courseCompleted: enrollment.progressPercent >= 100,
        threadId: input.threadId,
      },
      history: input.history,
      diagnostic_scope: {
        workspace_root: this.guestWorkspaceRoot(),
        allowed_tools: resources ? COMMON_DIAGNOSTIC_TOOLS : COMMON_DIAGNOSTIC_TOOLS.slice(0, 2),
        allowed_relative_paths: resources ? [".", "compose.yaml", "docker-compose.yml"] : [],
        allowed_services: resources ? ["docker.service"] : [],
        allowed_containers: resources?.containers ?? [],
        allowed_ports: resources?.ports ?? [],
        allowed_external_hosts: resources?.externalHosts ?? [],
        allowed_runtimes: [],
      },
    };
  }

  private guestWorkspaceRoot(): string {
    const root = (process.env.LABS_AGENT_WORKSPACE_ROOT ?? DEFAULT_GUEST_WORKSPACE_ROOT).trim();
    const parts = root.split("/");
    if (!root.startsWith("/") || root.includes("\0") || parts.includes("..")) {
      throw new ServiceUnavailableException("LABS_AGENT_WORKSPACE_ROOT is invalid");
    }
    return root.replace(/\/+$/, "") || "/";
  }
}
