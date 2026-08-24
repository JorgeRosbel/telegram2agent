import { describe, expect, it } from "vitest";
import { VERSION } from "@/index";

describe("VERSION", () => {
  it("expone la versión inyectada en build", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
