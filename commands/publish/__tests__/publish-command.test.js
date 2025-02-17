"use strict";

jest.mock("@lerna/otplease");

// local modules _must_ be explicitly mocked
jest.mock("../lib/get-packages-without-license");
jest.mock("../lib/verify-npm-package-access");
jest.mock("../lib/get-npm-username");
jest.mock("../lib/get-two-factor-auth-required");
jest.mock("../lib/get-unpublished-packages");
// FIXME: better mock for version command
jest.mock("../../version/lib/git-push");
jest.mock("../../version/lib/is-anything-committed");
jest.mock("../../version/lib/is-behind-upstream");
jest.mock("../../version/lib/remote-branch-exists");

// mocked or stubbed modules
const otplease = require("@lerna/otplease");
const npmDistTag = require("@lerna/npm-dist-tag");
const npmPublish = require("@lerna/npm-publish");
const packDirectory = require("@lerna/pack-directory");
const PromptUtilities = require("@lerna/prompt");
const collectUpdates = require("@lerna/collect-updates");
const getNpmUsername = require("../lib/get-npm-username");
const verifyNpmPackageAccess = require("../lib/verify-npm-package-access");
const getTwoFactorAuthRequired = require("../lib/get-two-factor-auth-required");

// helpers
const commitChangeToPackage = require("@lerna-test/commit-change-to-package");
const loggingOutput = require("@lerna-test/logging-output");
const initFixture = require("@lerna-test/init-fixture")(__dirname);

// file under test
const lernaPublish = require("@lerna-test/command-runner")(require("../command"));

expect.extend(require("@lerna-test/figgy-pudding-matchers"));

describe("PublishCommand", () => {
  describe("cli validation", () => {
    let cwd;

    beforeAll(async () => {
      cwd = await initFixture("normal");
    });

    it("exits early when no changes found", async () => {
      collectUpdates.setUpdated(cwd);

      await lernaPublish(cwd)();

      const logMessages = loggingOutput("success");
      expect(logMessages).toContain("No changed packages to publish");
      expect(verifyNpmPackageAccess).not.toHaveBeenCalled();
    });

    it("exits non-zero with --scope", async () => {
      try {
        await lernaPublish(cwd)("--scope", "package-1");
      } catch (err) {
        expect(err.exitCode).toBe(1);
        expect(err.message).toBe("Unknown argument: scope");
      }

      expect.assertions(2);
    });

    it("exits non-zero with --since", async () => {
      try {
        await lernaPublish(cwd)("--since", "master");
      } catch (err) {
        expect(err.exitCode).toBe(1);
        expect(err.message).toBe("Unknown argument: since");
      }

      expect.assertions(2);
    });

    it("errors when --git-head is passed without from-package positional", async () => {
      try {
        await lernaPublish(cwd)("--git-head", "deadbeef");
      } catch (err) {
        expect(err.message).toBe("--git-head is only allowed with 'from-package' positional");
      }

      expect.hasAssertions();
    });
  });

  describe("with implied versioning", () => {
    it("publishes changed packages", async () => {
      const testDir = await initFixture("normal");

      await lernaPublish(testDir)();

      expect(PromptUtilities.confirm).toHaveBeenLastCalledWith(
        "Are you sure you want to publish these packages?"
      );
      expect(packDirectory.registry).toMatchInlineSnapshot(`
Set {
  "package-1",
  "package-3",
  "package-4",
  "package-2",
}
`);
      expect(npmPublish.registry).toMatchInlineSnapshot(`
Map {
  "package-1" => "latest",
  "package-3" => "latest",
  "package-4" => "latest",
  "package-2" => "latest",
}
`);
      expect(npmPublish.order()).toEqual([
        "package-1",
        "package-3",
        "package-4",
        "package-2",
        // package-5 is private
      ]);
      expect(npmDistTag.remove).not.toHaveBeenCalled();
      expect(npmDistTag.add).not.toHaveBeenCalled();

      expect(getNpmUsername).toHaveBeenCalled();
      expect(getNpmUsername).toHaveBeenLastCalledWith(
        expect.figgyPudding({ registry: "https://registry.npmjs.org/" })
      );

      expect(verifyNpmPackageAccess).toHaveBeenCalled();
      expect(verifyNpmPackageAccess).toHaveBeenLastCalledWith(
        expect.any(Array),
        "lerna-test",
        expect.figgyPudding({ registry: "https://registry.npmjs.org/" })
      );

      expect(getTwoFactorAuthRequired).toHaveBeenCalled();
      expect(getTwoFactorAuthRequired).toHaveBeenLastCalledWith(
        // extra insurance that @lerna/npm-conf is defaulting things correctly
        expect.figgyPudding({ otp: undefined })
      );
    });

    it("publishes changed independent packages", async () => {
      const testDir = await initFixture("independent");

      await lernaPublish(testDir)();

      expect(npmPublish.order()).toEqual([
        "package-1",
        "package-3",
        "package-4",
        "package-2",
        // package-5 is private
      ]);
    });

    it("--skip-npm yields immediately to VersionCommand with warning", async () => {
      const cwd = await initFixture("normal");

      await lernaPublish(cwd)("--skip-npm");

      expect(npmPublish.order()).toHaveLength(0);

      const logMessages = loggingOutput("warn");
      expect(logMessages).toContain("Instead of --skip-npm, call `lerna version` directly");
    });

    it("throws an error in fixed mode when --independent is passed", async () => {
      const testDir = await initFixture("normal");

      try {
        await lernaPublish(testDir)("--independent");
      } catch (err) {
        expect(err.message).toMatch("independent");
      }

      expect.assertions(1);
    });
  });

  describe("--graph-type", () => {
    it("produces a topological ordering that _includes_ devDependencies when value is 'all'", async () => {
      const cwd = await initFixture("normal");

      await lernaPublish(cwd)("--graph-type", "all");

      expect(npmPublish.order()).toEqual([
        "package-1",
        "package-4",
        "package-2",
        // package-3 has a peer/devDependency on package-2
        "package-3",
        // package-5 is private
      ]);
    });

    it("throws an error when value is _not_ 'all' or 'dependencies'", async () => {
      const testDir = await initFixture("normal");

      try {
        await lernaPublish(testDir)("--graph-type", "poopy-pants");
      } catch (err) {
        expect(err.message).toMatch("poopy-pants");
      }

      expect.hasAssertions();
    });
  });

  describe("--otp", () => {
    otplease.getOneTimePassword.mockImplementation(() => Promise.resolve("654321"));

    it("passes one-time password to npm commands", async () => {
      const testDir = await initFixture("normal");
      const otp = "123456";

      // cli option skips prompt
      getTwoFactorAuthRequired.mockResolvedValueOnce(true);

      await lernaPublish(testDir)("--otp", otp);

      expect(npmPublish).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-1" }),
        "/TEMP_DIR/package-1-MOCKED.tgz",
        expect.objectContaining({ otp }),
        expect.objectContaining({ otp })
      );
      expect(otplease.getOneTimePassword).not.toHaveBeenCalled();
    });

    it("prompts for OTP when option missing and account-level 2FA enabled", async () => {
      const testDir = await initFixture("normal");

      getTwoFactorAuthRequired.mockResolvedValueOnce(true);

      await lernaPublish(testDir)();

      expect(npmPublish).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-1" }),
        "/TEMP_DIR/package-1-MOCKED.tgz",
        expect.objectContaining({ otp: undefined }),
        expect.objectContaining({ otp: "654321" })
      );
      expect(otplease.getOneTimePassword).toHaveBeenLastCalledWith("Enter OTP:");
    });
  });

  describe("--registry", () => {
    it("passes registry to npm commands", async () => {
      const testDir = await initFixture("normal");
      const registry = "https://my-private-registry";

      await lernaPublish(testDir)("--registry", registry);

      expect(npmPublish).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-1" }),
        "/TEMP_DIR/package-1-MOCKED.tgz",
        expect.objectContaining({ registry }),
        expect.objectContaining({ otp: undefined })
      );
    });

    it("overwrites yarn registry proxy with https://registry.npmjs.org/", async () => {
      const testDir = await initFixture("normal");
      const registry = "https://registry.yarnpkg.com";

      await lernaPublish(testDir)("--registry", registry);

      expect(npmPublish).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-1" }),
        "/TEMP_DIR/package-1-MOCKED.tgz",
        expect.objectContaining({ registry: "https://registry.npmjs.org/" }),
        expect.objectContaining({ otp: undefined })
      );

      const logMessages = loggingOutput("warn");
      expect(logMessages).toContain("Yarn's registry proxy is broken, replacing with public npm registry");
      expect(logMessages).toContain("If you don't have an npm token, you should exit and run `npm login`");
    });

    it("skips validation on any other third-party registry", async () => {
      const testDir = await initFixture("normal");
      const registry = "https://my-incompatible-registry.com";

      await lernaPublish(testDir)("--registry", registry);

      const logMessages = loggingOutput("notice");
      expect(logMessages).toContain("Skipping all user and access validation due to third-party registry");
    });
  });

  describe("--no-verify-access", () => {
    it("skips package access verification", async () => {
      const cwd = await initFixture("normal");

      await lernaPublish(cwd)("--no-verify-access");

      expect(verifyNpmPackageAccess).not.toHaveBeenCalled();
    });

    it("is implied when npm username is undefined", async () => {
      getNpmUsername.mockImplementationOnce(() => Promise.resolve());

      const cwd = await initFixture("normal");

      await lernaPublish(cwd)("--registry", "https://my-private-registry");

      expect(verifyNpmPackageAccess).not.toHaveBeenCalled();
    });
  });

  describe("--contents", () => {
    it("allows you to do fancy angular crap", async () => {
      const cwd = await initFixture("lifecycle");

      await lernaPublish(cwd)("--contents", "dist");

      for (const name of ["package-1", "package-2"]) {
        expect(packDirectory).toHaveBeenCalledWith(
          expect.objectContaining({ name }),
          expect.stringContaining(`packages/${name}/dist`),
          expect.any(Object)
        );
      }
    });
  });

  describe("publishConfig.directory", () => {
    it("mimics effect of --contents, but per-package", async () => {
      const cwd = await initFixture("lifecycle");

      await commitChangeToPackage(cwd, "package-1", "chore: setup", {
        publishConfig: {
          directory: "dist",
        },
      });

      await lernaPublish(cwd)();

      expect(packDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-1" }),
        expect.stringMatching(/packages\/package-1\/dist$/),
        expect.any(Object)
      );
      expect(packDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ name: "package-2" }),
        expect.stringMatching(/packages\/package-2$/),
        expect.any(Object)
      );
    });
  });
  describe("in a cyclical repo", () => {
    it("should throw an error with --reject-cycles", async () => {
      expect.assertions(1);

      try {
        const testDir = await initFixture("toposort");

        await lernaPublish(testDir)("--reject-cycles");
      } catch (err) {
        expect(err.message).toMatch("Dependency cycles detected, you should fix these!");
      }
    });
  });
});
