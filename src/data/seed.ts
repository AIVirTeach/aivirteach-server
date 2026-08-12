import { Activity, Course, Enrollment, Notification, PracticeSession, User } from "./models";

export const seedUsers: User[] = [
  { id: "learner_beginner", name: "Maya Tan", email: "maya.beginner@example.edu", role: "AI Foundations Learner", plan: "Free", level: 2, timezone: "Asia/Kuala_Lumpur", joinedAt: "2026-07-21", streakDays: 3, skillsMastered: 1, tasksCompleted: 9 },
  { id: "learner_advanced", name: "Alex Chen", email: "alex.chen@example.edu", role: "AI Automation Learner", plan: "Premium", level: 12, timezone: "Asia/Kuala_Lumpur", joinedAt: "2026-05-18", streakDays: 21, skillsMastered: 8, tasksCompleted: 187 },
  { id: "learner_all_clear", name: "Jordan Lee", email: "jordan.complete@example.edu", role: "AI Solutions Builder", plan: "Premium", level: 20, timezone: "Asia/Kuala_Lumpur", joinedAt: "2025-11-03", streakDays: 45, skillsMastered: 18, tasksCompleted: 436 },
];

export const seedCourses: Course[] = [
  { id: "n8n-agent-builder", title: "Build an AI Daily Briefing with n8n", category: "AI Automation", description: "Build a self-hosted workflow that retrieves, ranks, summarizes, and emails the most important AI and technology news each day.", level: "Intermediate", durationMinutes: 480, lessonCount: 11, published: true },
];

export const seedEnrollments: Enrollment[] = [
  { id: "enrollment_maya_briefing", userId: "learner_beginner", courseId: "n8n-agent-builder", active: true, progressPercent: 18, currentModule: "Module 1: Configure the Runtime Environment", enrolledAt: "2026-07-21T08:00:00.000Z" },
  { id: "enrollment_alex_n8n", userId: "learner_advanced", courseId: "n8n-agent-builder", active: true, progressPercent: 68, currentModule: "Module 2: Build the AI Daily Briefing Workflow", enrolledAt: "2026-05-18T08:00:00.000Z" },
  { id: "enrollment_jordan_briefing", userId: "learner_all_clear", courseId: "n8n-agent-builder", active: true, progressPercent: 100, currentModule: "All modules and assessments complete", enrolledAt: "2025-11-03T08:00:00.000Z" },
];

export const seedPracticeSessions: PracticeSession[] = [
  { id: "practice_alex_1", userId: "learner_advanced", courseId: "n8n-agent-builder", minutes: 96, startedAt: "2026-08-03T10:00:00.000Z" },
  { id: "practice_alex_2", userId: "learner_advanced", courseId: "n8n-agent-builder", minutes: 138, startedAt: "2026-08-02T10:00:00.000Z" },
  { id: "practice_maya_1", userId: "learner_beginner", courseId: "n8n-agent-builder", minutes: 48, startedAt: "2026-08-03T11:00:00.000Z" },
];

export const seedNotifications: Notification[] = [
  { id: "notification_alex_1", userId: "learner_advanced", message: "Your tutor left feedback on Deployment checklist.", createdAt: "2026-08-04T01:42:00.000Z", readAt: null },
  { id: "notification_alex_2", userId: "learner_advanced", message: "Your weekly goal is 86% complete.", createdAt: "2026-08-03T10:10:00.000Z", readAt: null },
  { id: "notification_maya_1", userId: "learner_beginner", message: "Welcome, Maya! Your first learning path is ready.", createdAt: "2026-08-04T02:15:00.000Z", readAt: null },
  { id: "notification_jordan_1", userId: "learner_all_clear", message: "Your capstone certificate is ready to view.", createdAt: "2026-08-03T04:20:00.000Z", readAt: "2026-08-03T05:00:00.000Z" },
];

export const seedActivities: Activity[] = [
  { id: "activity_alex_1", userId: "learner_advanced", title: "Deployment checklist", detail: "Completed lesson 3 of Module 4", kind: "lesson", occurredAt: "2026-08-04T01:42:00.000Z" },
  { id: "activity_alex_2", userId: "learner_advanced", title: "Webhook debugging", detail: "Practised for 38 minutes", kind: "practice", occurredAt: "2026-08-03T10:10:00.000Z" },
  { id: "activity_maya_1", userId: "learner_beginner", title: "Workflow vocabulary", detail: "Practised for 22 minutes", kind: "practice", occurredAt: "2026-08-03T11:40:00.000Z" },
];
