export type Plan = "Free" | "Premium";

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: Plan;
  level: number;
  timezone: string;
  joinedAt: string;
  streakDays: number;
  skillsMastered: number;
  tasksCompleted: number;
};

export type Course = {
  id: string;
  title: string;
  category: string;
  description: string;
  level: "Beginner" | "Intermediate" | "Advanced";
  durationMinutes: number;
  lessonCount: number;
  published: boolean;
};

export type Enrollment = {
  id: string;
  userId: string;
  courseId: string;
  active: boolean;
  progressPercent: number;
  currentModule: string;
  enrolledAt: string;
};

export type PracticeSession = {
  id: string;
  userId: string;
  courseId: string | null;
  minutes: number;
  startedAt: string;
};

export type Notification = {
  id: string;
  userId: string;
  message: string;
  createdAt: string;
  readAt: string | null;
};

export type Activity = {
  id: string;
  userId: string;
  title: string;
  detail: string;
  kind: "lesson" | "practice" | "achievement";
  occurredAt: string;
};

export type ChatMessage = {
  id: string;
  userId: string;
  threadId: string;
  role: "student" | "tutor";
  text: string;
  provider?: string | null;
  createdAt: string;
};
