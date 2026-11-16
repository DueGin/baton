import { describe, expect, it } from "vitest";
import { loginShellEnv, parseShellEnv } from "./shell-env.js";
describe("login environment", () => {
  it("parses NUL separated values, newlines and equals without evaluating shell text", () => {
    expect(parseShellEnv("welcome\nPATH=/nvm/bin:/usr/bin\0TOKEN=a=b=c\0MULTILINE=one\ntwo\0EMPTY=\0garbage\0__proto__=oops\0")).toEqual({ PATH: "/nvm/bin:/usr/bin", TOKEN: "a=b=c", MULTILINE: "one\ntwo", EMPTY: "" });
  });
  it("inherits Windows environment unchanged", async () => {
    const env = { Path: "C:\\tools", BATON_HOME: "C:\\baton" }; expect(await loginShellEnv(env, "win32")).toEqual(env);
  });
});
