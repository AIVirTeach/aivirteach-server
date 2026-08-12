import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { LearningService } from "../learning/learning.service";
import { CourseContentService } from "../content/course-content.service";
import { DashboardService } from "./dashboard.service";

describe("DashboardService", () => {
  it("returns an aggregated dashboard for the default advanced learner", async () => {
    const db = new InMemoryDatabaseService();
    const service = new DashboardService(db, new LearningService(db, new CourseContentService()));
    const result = await service.get("learner_advanced");

    expect(result.learner.name).toBe("Alex Chen");
    expect(result.activeCourse?.id).toBe("n8n-agent-builder");
    expect(result.unreadNotificationCount).toBe(2);
  });
});
