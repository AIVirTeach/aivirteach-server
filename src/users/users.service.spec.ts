import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { UsersService } from "./users.service";

describe("UsersService", () => {
  it("creates a demo learner without enrolling them in a course", async () => {
    const db = new InMemoryDatabaseService();
    const user = await new UsersService(db).createDemo({ name: "Sam Lee", email: "sam@example.edu" });

    expect(user.name).toBe("Sam Lee");
    expect(await db.activeEnrollment(user.id)).toBeUndefined();
    expect(await db.userEnrollments(user.id)).toHaveLength(0);
  });

  it("restores a seeded learner and their related state", async () => {
    const db = new InMemoryDatabaseService();
    const service = new UsersService(db);
    await service.update("learner_advanced", { name: "Changed" });
    db.practiceSessions.push({ id: "extra", userId: "learner_advanced", courseId: null, minutes: 10, startedAt: new Date().toISOString() });

    service.reset("learner_advanced");

    expect((await db.findUser("learner_advanced"))?.name).toBe("Alex Chen");
    expect((await db.userPracticeSessions("learner_advanced")).some((item) => item.id === "extra")).toBe(false);
  });
});
