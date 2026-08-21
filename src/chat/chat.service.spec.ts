import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { CourseContentService } from "../content/course-content.service";
import { DatabaseRepository } from "../data/database-repository";
import { ChatMessage, Enrollment } from "../data/models";
import { LabsService } from "../labs/labs.service";
import { ChatService } from "./chat.service";
import { LabsAgentClient } from "./labs-agent.client";

describe("ChatService", () => {
  const userId = "learner_advanced";
  const threadId = "chat:v1:learner_advanced:ai-daily-briefing";
  const enrollment: Enrollment = {
    id: "enrollment-1",
    userId,
    courseId: "ai-daily-briefing",
    active: true,
    progressPercent: 50,
    currentModule: "Module 1",
    enrolledAt: "2026-08-20T00:00:00.000Z",
  };
  const course = {
    id: "ai-daily-briefing",
    slug: "ai-daily-briefing",
    version: 1,
    title: "AI Daily Briefing",
    shortTitle: "Daily Briefing",
    category: "AI Automation",
    description: "Build an automated briefing.",
    level: "Intermediate" as const,
    durationMinutes: 120,
    lessonCount: 2,
    language: "en",
    tags: ["n8n"],
    published: true,
    outcomes: [],
    requirements: [],
    assets: [],
    featuredAssetIds: [],
    modules: [{
      id: "runtime-environment",
      position: 1,
      title: "Runtime",
      description: "Prepare the runtime.",
      estimatedMinutes: 60,
      lessons: [
        {
          id: "install-docker",
          position: 1,
          title: "Install Docker",
          estimatedMinutes: 30,
          objectives: ["Docker is installed."],
          activity: { type: "guided-lab", prompt: "Install Docker.", completionType: "learner-confirmation" },
        },
        {
          id: "install-n8n",
          position: 2,
          title: "Install n8n",
          estimatedMinutes: 30,
          objectives: ["n8n is running."],
          activity: { type: "guided-lab", prompt: "Start n8n.", completionType: "learner-confirmation" },
        },
      ],
    }],
  } as ReturnType<CourseContentService["getCourse"]>;

  let db: jest.Mocked<DatabaseRepository>;
  let content: jest.Mocked<Pick<CourseContentService, "getCourse">>;
  let labs: jest.Mocked<Pick<LabsService, "assignedLabId">>;
  let agent: jest.Mocked<Pick<LabsAgentClient, "diagnose">>;
  let service: ChatService;

  beforeEach(() => {
    db = {
      findUser: jest.fn().mockResolvedValue({ id: userId }),
      activeEnrollment: jest.fn().mockResolvedValue(enrollment),
      listChatMessages: jest.fn().mockResolvedValue([]),
      saveChatMessages: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DatabaseRepository>;
    content = { getCourse: jest.fn().mockReturnValue(course) };
    labs = { assignedLabId: jest.fn().mockReturnValue("lab-001") };
    agent = { diagnose: jest.fn().mockResolvedValue({ status: "completed", answer: "Agent answer" }) };
    service = new ChatService(
      db,
      content as unknown as CourseContentService,
      labs as unknown as LabsService,
      agent as unknown as LabsAgentClient,
    );
  });

  it("persists the student message before Agent diagnosis and the tutor answer afterwards", async () => {
    const events: string[] = [];
    db.saveChatMessages.mockImplementation(async (messages) => {
      events.push(`save:${messages[0].role}`);
    });
    agent.diagnose.mockImplementation(async () => {
      events.push("agent");
      return { status: "completed", answer: "The n8n container is stopped." };
    });

    const result = await service.send(userId, threadId, "Why is n8n unavailable?");

    expect(events).toEqual(["save:student", "agent", "save:tutor"]);
    expect(db.saveChatMessages.mock.calls[0][0]).toEqual([
      expect.objectContaining({ role: "student", text: "Why is n8n unavailable?", provider: null }),
    ]);
    expect(db.saveChatMessages.mock.calls[1][0]).toEqual([
      expect.objectContaining({ role: "tutor", text: "The n8n container is stopped.", provider: "labs-agent" }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      provider: "labs-agent",
      studentMessage: expect.objectContaining({ role: "student" }),
      tutorMessage: expect.objectContaining({ role: "tutor", text: "The n8n container is stopped." }),
    }));
  });

  it("derives the active course and current lesson and sends stored history to Agent", async () => {
    const stored: ChatMessage[] = [
      { id: "m1", userId, threadId, role: "student", text: "Earlier question", createdAt: "2026-08-20T00:00:00.000Z" },
      { id: "m2", userId, threadId, role: "tutor", text: "Earlier answer", createdAt: "2026-08-20T00:00:01.000Z" },
    ];
    db.listChatMessages.mockResolvedValue(stored);

    await service.send(userId, threadId, "n8n 为什么打不开？");

    expect(content.getCourse).toHaveBeenCalledWith("ai-daily-briefing");
    expect(labs.assignedLabId).toHaveBeenCalledWith(userId);
    expect(agent.diagnose).toHaveBeenCalledWith(expect.objectContaining({
      lab_id: "lab-001",
      question: "n8n 为什么打不开？",
      response_language: "zh-CN",
      course: expect.objectContaining({ course_id: "ai-daily-briefing", version: 1 }),
      current_step: expect.objectContaining({
        module_id: "runtime-environment",
        lesson_id: "install-n8n",
        sequence: 2,
      }),
      learner_state: expect.objectContaining({ progressPercent: 50, currentLessonId: "install-n8n" }),
      history: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      diagnostic_scope: expect.objectContaining({
        allowed_services: ["docker.service"],
        allowed_containers: ["n8n"],
        allowed_ports: [5678],
      }),
    }));
  });

  it("uses the same floor-based progress calculation as the client", async () => {
    db.activeEnrollment.mockResolvedValue({ ...enrollment, progressPercent: 49 });

    await service.send(userId, threadId, "Help with this step");

    expect(agent.diagnose).toHaveBeenCalledWith(expect.objectContaining({
      current_step: expect.objectContaining({ lesson_id: "install-docker", sequence: 1 }),
    }));
  });

  it("uses an explicitly selected lesson after validating it against the active course", async () => {
    db.activeEnrollment.mockResolvedValue({ ...enrollment, progressPercent: 0 });

    await service.send(userId, threadId, "Help with n8n", {
      courseId: "ai-daily-briefing",
      lessonId: "install-n8n",
    });

    expect(agent.diagnose).toHaveBeenCalledWith(expect.objectContaining({
      current_step: expect.objectContaining({ lesson_id: "install-n8n", sequence: 2 }),
    }));
  });

  it("rejects a course that is not the active enrollment before persisting or calling Agent", async () => {
    await expect(service.send(userId, threadId, "Help", {
      courseId: "ai-web-watcher-agent",
      lessonId: "install-n8n",
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(db.saveChatMessages).not.toHaveBeenCalled();
    expect(agent.diagnose).not.toHaveBeenCalled();
  });

  it("rejects a lesson outside the active course before persisting or calling Agent", async () => {
    await expect(service.send(userId, threadId, "Help", {
      courseId: "ai-daily-briefing",
      lessonId: "not-a-course-lesson",
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(db.saveChatMessages).not.toHaveBeenCalled();
    expect(agent.diagnose).not.toHaveBeenCalled();
  });

  it("keeps the persisted student message but does not create a tutor message when Agent fails", async () => {
    agent.diagnose.mockRejectedValue(new ServiceUnavailableException("Agent unavailable"));

    await expect(service.send(userId, threadId, "Help")).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(db.saveChatMessages).toHaveBeenCalledTimes(1);
    expect(db.saveChatMessages.mock.calls[0][0][0].role).toBe("student");
  });

  it("lists history only from server storage and never calls Agent", async () => {
    const stored: ChatMessage[] = [
      { id: "m1", userId, threadId, role: "student", text: "Stored", createdAt: "2026-08-20T00:00:00.000Z" },
    ];
    db.listChatMessages.mockResolvedValue(stored);

    await expect(service.list(userId, threadId)).resolves.toBe(stored);
    expect(db.listChatMessages).toHaveBeenCalledWith(userId, threadId);
    expect(agent.diagnose).not.toHaveBeenCalled();
  });

  it("rejects a thread namespace owned by another learner", async () => {
    await expect(service.list(userId, "chat:v1:learner_beginner:ai-daily-briefing")).rejects.toBeInstanceOf(BadRequestException);
    expect(db.listChatMessages).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only question before it is persisted", async () => {
    await expect(service.send(userId, threadId, "   \n  ")).rejects.toBeInstanceOf(BadRequestException);
    expect(db.findUser).not.toHaveBeenCalled();
    expect(db.saveChatMessages).not.toHaveBeenCalled();
    expect(agent.diagnose).not.toHaveBeenCalled();
  });
});
