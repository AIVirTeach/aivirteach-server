import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { CourseContentService } from "../content/course-content.service";
import { CoursesService } from "./courses.service";

describe("CoursesService", () => {
  it("changes the active course without creating duplicate enrollments", async () => {
    const db = new InMemoryDatabaseService();
    const service = new CoursesService(db, new CourseContentService());

    await service.enroll("learner_advanced", "n8n-agent-builder");
    await service.enroll("learner_advanced", "n8n-agent-builder");

    const active = (await db.userEnrollments("learner_advanced")).filter((item) => item.active);
    expect(active).toHaveLength(1);
    expect(active[0].courseId).toBe("n8n-agent-builder");
  });

  it("restarts an enrolled course at its first module", async () => {
    const db = new InMemoryDatabaseService();
    const service = new CoursesService(db, new CourseContentService());

    const restarted = await service.restart("learner_advanced", "n8n-agent-builder");

    expect(restarted.progressPercent).toBe(0);
    expect(restarted.active).toBe(false);
    expect(restarted.currentModule).toBe("Module 1: Configure the Runtime Environment");
  });

  it("loads course welcome content from the published package", () => {
    const service = new CoursesService(new InMemoryDatabaseService(), new CourseContentService());
    const welcome = service.getWelcome("n8n-agent-builder");

    expect(welcome.overview.heading).toBe("Build an AI Daily Briefing");
    expect(welcome.howItWorks.steps).toHaveLength(4);
    expect(welcome.finalOutcome.description).toContain("persistent");
    expect(welcome.overviewAsset.id).toBe("course-overview");
  });
});
