/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import td from "testdouble"

import { GardenCli, validateRuntimeRequirementsCached } from "../../../../src/cli/cli"
import { getDataDir, projectRootA, initTestLogger } from "../../../helpers"
import { gardenEnv, GARDEN_CORE_ROOT } from "../../../../src/constants"
import { join, resolve } from "path"
import { Command, CommandGroup, CommandParams, PrepareParams } from "../../../../src/commands/base"
import { getPackageVersion } from "../../../../src/util/util"
import { UtilCommand } from "../../../../src/commands/util/util"
import { StringParameter } from "../../../../src/cli/params"
import stripAnsi from "strip-ansi"
import { ToolsCommand } from "../../../../src/commands/tools"
import { getRootLogger, RootLogger } from "../../../../src/logger/logger"
import { safeLoad } from "js-yaml"
import { startServer } from "../../../../src/server/server"
import { envSupportsEmoji } from "../../../../src/logger/util"
import { expectError } from "../../../../src/util/testing"
import { GlobalConfigStore } from "../../../../src/config-store/global"
import tmp from "tmp-promise"
import { CloudCommand } from "../../../../src/commands/cloud/cloud"
import { registerProcess } from "../../../../src/process"
import { ServeCommand } from "../../../../src/commands/serve"
import { GardenInstanceManager } from "../../../../src/server/instance-manager"
import { mkdirp } from "fs-extra"
import { uuidv4 } from "../../../../src/util/random"
import { makeDummyGarden } from "../../../../src/garden"

describe("cli", () => {
  let cli: GardenCli
  const globalConfigStore = new GlobalConfigStore()
  const log = getRootLogger().createLog()
  const sessionId = uuidv4()

  beforeEach(() => {
    cli = new GardenCli()
  })

  afterEach(async () => {
    if (cli.processRecord && cli.processRecord.pid) {
      await globalConfigStore.delete("activeProcesses", String(cli.processRecord.pid))
    }
  })

  describe("run", () => {
    it("aborts with help text if no positional argument is provided", async () => {
      const { code, consoleOutput } = await cli.run({ args: [], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(await cli.renderHelp(log, "/"))
    })

    it("aborts with default help text if -h option is set and no command", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["-h"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(await cli.renderHelp(log, "/"))
    })

    it("aborts with default help text if --help option is set and no command", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["-h"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(await cli.renderHelp(log, "/"))
    })

    it("aborts with command help text if --help option is set and command is specified", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ args }) {
          return { result: { args } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const { code, consoleOutput } = await cli.run({ args: ["test-command", "--help"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(cmd.renderHelp())
    })

    it("aborts with version text if -V is set", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["-V"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(getPackageVersion())
    })

    it("aborts with version text if --version is set", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["--version"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(getPackageVersion())
    })

    it("aborts with version text if version is first argument", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["version"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(getPackageVersion())
    })

    it("throws if --root is set, pointing to a non-existent path", async () => {
      const path = "/tmp/hauweighaeighuawek"
      const { code, consoleOutput } = await cli.run({ args: ["--root", path], exitOnError: false })

      expect(code).to.equal(1)
      expect(stripAnsi(consoleOutput!)).to.equal(`Could not find specified root path (${path})`)
    })

    context("custom commands", () => {
      const root = getDataDir("test-projects", "custom-commands")

      it("picks up all commands in project root", async () => {
        const commands = await cli["getCustomCommands"](log, root)

        expect(commands.map((c) => c.name).sort()).to.eql(["combo", "echo", "run-task", "script"])
      })

      it("runs a custom command", async () => {
        const res = await cli.run({ args: ["echo", "foo"], exitOnError: false, cwd: root })

        expect(res.code).to.equal(0)
      })

      it("warns and ignores custom command with same name as built-in command", async () => {
        const commands = await cli["getCustomCommands"](log, root)

        // The plugin(s) commands are defined in nope.garden.yml
        expect(commands.map((c) => c.name)).to.not.include("plugins")
      })

      it("warns if a custom command is provided with same name as alias for built-in command", async () => {
        const commands = await cli["getCustomCommands"](log, root)

        // The plugin(s) commands are defined in nope.garden.yml
        expect(commands.map((c) => c.name)).to.not.include("plugin")
      })

      it("doesn't pick up commands outside of project root", async () => {
        const commands = await cli["getCustomCommands"](log, root)

        // The nope command is defined in the `nope` directory in the test project.
        expect(commands.map((c) => c.name)).to.not.include("nope")
      })

      it("prints custom commands in help text", async () => {
        const helpText = stripAnsi(await cli.renderHelp(log, root))

        expect(helpText).to.include("CUSTOM COMMANDS")

        expect(helpText).to.include("combo     A complete example using most")
        expect(helpText).to.include("available features") // There's a line break

        expect(helpText).to.include("echo      Just echo a string")
        expect(helpText).to.include("run-task  Run the specified task")
      })

      it("prints help text for a custom command", async () => {
        const res = await cli.run({ args: ["combo", "--help"], exitOnError: false, cwd: root })

        const commands = await cli["getCustomCommands"](log, root)
        const command = commands.find((c) => c.name === "combo")!
        const helpText = command.renderHelp()

        expect(res.code).to.equal(0)
        expect(res.consoleOutput).to.equal(helpText)
      })

      it("errors if a Command resource is invalid", async () => {
        return expectError(
          () =>
            cli.run({
              args: ["echo", "foo"],
              exitOnError: false,
              cwd: getDataDir("test-projects", "custom-commands-invalid"),
            }),
          { contains: "Error validating custom Command 'invalid'" }
        )
      })

      it("exits with code from exec command if it fails", async () => {
        const res = await cli.run({ args: ["script", "exit 2"], exitOnError: false, cwd: root })

        expect(res.code).to.equal(2)
      })

      it("exits with code 1 if Garden command fails", async () => {
        const res = await cli.run({ args: ["run", "fail"], exitOnError: false, cwd: root })

        expect(res.code).to.equal(1)
      })
    })

    context("test logger initialization", () => {
      const envLoggerType = process.env.GARDEN_LOGGER_TYPE
      const envLogLevel = process.env.GARDEN_LOG_LEVEL

      // Logger is a singleton and we need to reset it between these tests as we're testing
      // that it's initialised correctly in this block.
      beforeEach(() => {
        delete process.env.GARDEN_LOGGER_TYPE
        delete process.env.GARDEN_LOG_LEVEL
        gardenEnv.GARDEN_LOGGER_TYPE = ""
        gardenEnv.GARDEN_LOG_LEVEL = ""
        RootLogger.clearInstance()
      })
      // Re-initialise the test logger
      after(() => {
        process.env.GARDEN_LOGGER_TYPE = envLoggerType
        process.env.GARDEN_LOG_LEVEL = envLogLevel
        gardenEnv.GARDEN_LOGGER_TYPE = envLoggerType || ""
        gardenEnv.GARDEN_LOG_LEVEL = envLogLevel || ""
        RootLogger.clearInstance()
        initTestLogger()
      })

      it("uses the 'TerminalWriter' by default", async () => {
        class TestCommand extends Command {
          name = "test-command"
          help = "halp!"
          noProject = true

          printHeader() {}

          async action({}) {
            return { result: { something: "important" } }
          }
        }

        const cmd = new TestCommand()
        cli.addCommand(cmd)

        await cli.run({ args: ["test-command"], exitOnError: false })

        const logger = log.root
        const writers = logger.getWriters()
        expect(writers.display.type).to.equal("default")
      })
    })

    it("shows group help text if specified command is a group", async () => {
      const cmd = new UtilCommand()
      const { code, consoleOutput } = await cli.run({ args: ["util"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(cmd.renderHelp())
    })

    it("shows nested subcommand help text if provided subcommand is a group", async () => {
      const cmd = new CloudCommand()
      const secrets = new cmd.subCommands[0]()
      const { code, consoleOutput } = await cli.run({ args: ["cloud", "secrets"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(secrets.renderHelp())
    })

    it("shows nested subcommand help text if requested", async () => {
      const cmd = new CloudCommand()
      const secrets = new cmd.subCommands[0]()
      const { code, consoleOutput } = await cli.run({ args: ["cloud", "secrets", "--help"], exitOnError: false })

      expect(code).to.equal(0)
      expect(consoleOutput).to.equal(secrets.renderHelp())
    })

    it("errors and shows general help if nonexistent command is given", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["nonexistent"], exitOnError: false })

      expect(code).to.equal(1)
      expect(consoleOutput).to.equal(await cli.renderHelp(log, "/"))
    })

    it("errors and shows general help if nonexistent command is given with --help", async () => {
      const { code, consoleOutput } = await cli.run({ args: ["nonexistent", "--help"], exitOnError: false })

      expect(code).to.equal(1)
      expect(consoleOutput).to.equal(await cli.renderHelp(log, "/"))
    })

    it("picks and runs a command", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({}) {
          return { result: { something: "important" } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const { code, result } = await cli.run({ args: ["test-command"], exitOnError: false })

      expect(code).to.equal(0)
      expect(result).to.eql({ something: "important" })
    })

    it("handles params specified before the command", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({}) {
          return { result: { something: "important" } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const { code, result } = await cli.run({ args: ["test-command"], exitOnError: false })

      expect(code).to.equal(0)
      expect(result).to.eql({ something: "important" })
    })

    it("updates the GardenProcess entry if given with command info before running (no server)", async () => {
      const args = ["test-command", "--root", projectRootA]
      const processRecord = await registerProcess(globalConfigStore, "test-command", args)

      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"

        printHeader() {}

        async action({ garden }: CommandParams) {
          const record = await globalConfigStore.get("activeProcesses", String(processRecord.pid))

          expect(record.command).to.equal(this.name)
          expect(record.sessionId).to.exist
          expect(record.persistent).to.equal(false)
          expect(record.serverHost).to.equal(null)
          expect(record.serverAuthKey).to.equal(null)
          expect(record.projectRoot).to.equal(garden.projectRoot)
          expect(record.projectName).to.equal(garden.projectName)
          expect(record.environmentName).to.equal(garden.environmentName)
          expect(record.namespace).to.equal(garden.namespace)

          return { result: {} }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      try {
        const result = await cli.run({ args, exitOnError: false, processRecord })
        if (result.errors[0]) {
          throw result.errors[0]
        }
      } finally {
        await globalConfigStore.delete("activeProcesses", String(processRecord.pid))
      }
    })

    it("updates the GardenProcess entry if given with command info before running (with server)", async () => {
      const args = ["test-command", "--root", projectRootA]
      const processRecord = await registerProcess(globalConfigStore, "test-command", args)

      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"

        maybePersistent() {
          return true
        }

        async prepare({ log: _log }: PrepareParams) {
          this.server = await startServer({
            log: _log,
            defaultProjectRoot: projectRootA,
            manager: GardenInstanceManager.getInstance({ log, sessionId, serveCommand: new ServeCommand() }),
          })
        }

        printHeader() {}

        async action({ garden }: CommandParams) {
          const record = await globalConfigStore.get("activeProcesses", String(processRecord.pid))

          expect(record.command).to.equal(this.name)
          expect(record.sessionId).to.exist
          expect(record.persistent).to.equal(true)
          expect(record.serverHost).to.equal(this.server!.getUrl())
          expect(record.serverAuthKey).to.equal(this.server!.authKey)
          expect(record.projectRoot).to.equal(garden.projectRoot)
          expect(record.projectName).to.equal(garden.projectName)
          expect(record.environmentName).to.equal(garden.environmentName)
          expect(record.namespace).to.equal(garden.namespace)

          return { result: {} }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      try {
        const result = await cli.run({ args, exitOnError: false, processRecord })
        if (result.errors[0]) {
          throw result.errors[0]
        }
      } finally {
        await globalConfigStore.delete("activeProcesses", String(processRecord.pid))
      }
    })

    it.skip("shows the URL of the Garden Cloud dashboard", async () => {
      throw "TODO-G2"
    })

    it("picks and runs a subcommand in a group", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({}) {
          return { result: { something: "important" } }
        }
      }

      class TestGroup extends CommandGroup {
        name = "test-group"
        help = ""

        subCommands = [TestCommand]
      }

      const group = new TestGroup()

      for (const cmd of group.getSubCommands()) {
        cli.addCommand(cmd)
      }

      const { code, result } = await cli.run({ args: ["test-group", "test-command"], exitOnError: false })

      expect(code).to.equal(0)
      expect(result).to.eql({ something: "important" })
    })

    it("correctly parses and passes global options", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const _args = [
        "test-command",
        "--root",
        "..",
        "--silent",
        "--env=default",
        "-l=4",
        "--output",
        "json",
        "--yes",
        "--emoji=false",
        "--logger-type=json",
        "--show-timestamps=false",
        "--force-refresh",
        "--var",
        "my=value,other=something",
      ]

      const { code, result } = await cli.run({
        args: _args,
        exitOnError: false,
      })

      expect(code).to.equal(0)
      expect(result).to.eql({
        args: { "$all": _args.slice(1), "--": [] },
        opts: {
          "root": resolve(process.cwd(), ".."),
          "silent": true,
          "env": "default",
          "logger-type": "json",
          "log-level": "4",
          "output": "json",
          "emoji": false,
          "show-timestamps": false,
          "yes": true,
          "force-refresh": true,
          "var": ["my=value", "other=something"],
          "version": false,
          "help": false,
        },
      })
    })

    it("allows setting env through GARDEN_ENVIRONMENT env variable", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const saveEnv = gardenEnv.GARDEN_ENVIRONMENT

      try {
        gardenEnv.GARDEN_ENVIRONMENT = "foo"

        const { code, result } = await cli.run({
          args: ["test-command"],
          exitOnError: false,
        })

        expect(code).to.equal(0)
        expect(result.opts.env).to.equal("foo")
      } finally {
        gardenEnv.GARDEN_ENVIRONMENT = saveEnv
      }
    })

    it("prefers --env over GARDEN_ENVIRONMENT env variable", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const saveEnv = gardenEnv.GARDEN_ENVIRONMENT

      try {
        gardenEnv.GARDEN_ENVIRONMENT = "bar"

        const { code, result } = await cli.run({
          args: ["test-command", "--env", "foo"],
          exitOnError: false,
        })

        expect(code).to.equal(0)
        expect(result.opts.env).to.equal("foo")
      } finally {
        gardenEnv.GARDEN_ENVIRONMENT = saveEnv
      }
    })

    it("correctly parses and passes arguments and options for a command", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        arguments = {
          foo: new StringParameter({
            help: "Some help text.",
            required: true,
          }),
          bar: new StringParameter({
            help: "Another help text.",
          }),
        }

        options = {
          floop: new StringParameter({
            help: "Option help text.",
          }),
        }

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const { code, result } = await cli.run({
        args: ["test-command", "foo-arg", "bar-arg", "--floop", "floop-opt", "--", "extra"],
        exitOnError: false,
      })

      expect(code).to.equal(0)
      expect(result).to.eql({
        args: {
          "$all": ["foo-arg", "bar-arg", "--floop", "floop-opt", "--", "extra"],
          "--": ["extra"],
          "foo": "foo-arg",
          "bar": "bar-arg",
        },
        opts: {
          "silent": false,
          "log-level": "info",
          "emoji": envSupportsEmoji(),
          "show-timestamps": false,
          "yes": false,
          "force-refresh": false,
          "version": false,
          "help": false,
          "floop": "floop-opt",
          "env": undefined,
          "logger-type": undefined,
          "output": undefined,
          "root": undefined,
          "var": undefined,
        },
      })
    })

    it("correctly parses and passes arguments and options for a subcommand", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        arguments = {
          foo: new StringParameter({
            help: "Some help text.",
            required: true,
          }),
          bar: new StringParameter({
            help: "Another help text.",
          }),
        }

        options = {
          floop: new StringParameter({
            help: "Option help text.",
          }),
        }

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      class TestGroup extends CommandGroup {
        name = "test-group"
        help = ""

        subCommands = [TestCommand]
      }

      const group = new TestGroup()

      for (const cmd of group.getSubCommands()) {
        cli.addCommand(cmd)
      }

      const { code, result } = await cli.run({
        args: ["test-group", "test-command", "foo-arg", "bar-arg", "--floop", "floop-opt"],
        exitOnError: false,
      })

      expect(code).to.equal(0)
      expect(result).to.eql({
        args: {
          "$all": ["foo-arg", "bar-arg", "--floop", "floop-opt"],
          "--": [],
          "foo": "foo-arg",
          "bar": "bar-arg",
        },
        opts: {
          "silent": false,
          "log-level": "info",
          "emoji": envSupportsEmoji(),
          "show-timestamps": false,
          "yes": false,
          "force-refresh": false,
          "version": false,
          "help": false,
          "floop": "floop-opt",
          "env": undefined,
          "logger-type": undefined,
          "output": undefined,
          "root": undefined,
          "var": undefined,
        },
      })
    })

    it("aborts with usage information on invalid global options", async () => {
      const cmd = new ToolsCommand()
      const { code, consoleOutput } = await cli.run({ args: ["tools", "--logger-type", "bla"], exitOnError: false })

      const stripped = stripAnsi(consoleOutput!).trim()

      expect(code).to.equal(1)
      expect(
        stripped.startsWith('Invalid value for option --logger-type: "bla" is not a valid argument (should be any of ')
      ).to.be.true
      expect(consoleOutput).to.include(cmd.renderHelp())
    })

    it("aborts with usage information on missing/invalid command arguments and options", async () => {
      class TestCommand extends Command {
        name = "test-command"
        aliases = ["some-alias"]
        help = ""
        noProject = true

        arguments = {
          foo: new StringParameter({
            help: "Some help text.",
            required: true,
          }),
        }

        printHeader() {}

        async action({ args, opts }) {
          return { result: { args, opts } }
        }
      }

      const cmd = new TestCommand()
      cli.addCommand(cmd)

      const { code, consoleOutput } = await cli.run({ args: ["test-command"], exitOnError: false })

      const stripped = stripAnsi(consoleOutput!).trim()

      expect(code).to.equal(1)
      expect(stripped.startsWith("Missing required argument foo")).to.be.true
      expect(consoleOutput).to.include(cmd.renderHelp())
    })

    it("should pass array of all arguments to commands as $all", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ args }) {
          return { result: { args } }
        }
      }

      const command = new TestCommand()
      cli.addCommand(command)

      const { result } = await cli.run({ args: ["test-command", "--", "-v", "--flag", "arg"], exitOnError: false })
      expect(result.args.$all).to.eql(["--", "-v", "--flag", "arg"])
    })

    it("should not parse args after -- and instead pass directly to commands", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ args }) {
          return { result: { args } }
        }
      }

      const command = new TestCommand()
      cli.addCommand(command)

      const { result } = await cli.run({ args: ["test-command", "--", "-v", "--flag", "arg"], exitOnError: false })
      expect(result.args["--"]).to.eql(["-v", "--flag", "arg"])
    })

    it("should correctly parse --var flag", async () => {
      class TestCommand extends Command {
        name = "test-command-var"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ garden }) {
          return { result: { variables: garden.variables } }
        }
      }

      const command = new TestCommand()
      cli.addCommand(command)

      const { result } = await cli.run({
        args: ["test-command-var", "--var", 'key-a=value-a,key-b="value with quotes"'],
        exitOnError: false,
      })
      expect(result).to.eql({ variables: { "key-a": "value-a", "key-b": "value with quotes" } })
    })

    it("should output JSON if --output=json", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action() {
          return { result: { some: "output" } }
        }
      }

      const command = new TestCommand()
      cli.addCommand(command)

      const { consoleOutput } = await cli.run({ args: ["test-command", "--output=json"], exitOnError: false })
      expect(JSON.parse(consoleOutput!)).to.eql({ result: { some: "output" }, success: true })
    })

    it("should output YAML if --output=json", async () => {
      class TestCommand extends Command {
        name = "test-command"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action() {
          return { result: { some: "output" } }
        }
      }

      const command = new TestCommand()
      cli.addCommand(command)

      const { consoleOutput } = await cli.run({ args: ["test-command", "--output=yaml"], exitOnError: false })
      expect(safeLoad(consoleOutput!)).to.eql({ result: { some: "output" }, success: true })
    })

    it(`should configure a dummy environment when command has noProject=true and --env is specified`, async () => {
      class TestCommand2 extends Command {
        name = "test-command-2"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ garden }) {
          return { result: { environmentName: garden.environmentName } }
        }
      }

      const command = new TestCommand2()
      cli.addCommand(command)

      const { result, errors } = await cli.run({ args: ["test-command-2", "--env", "missing-env"], exitOnError: false })
      expect(errors).to.eql([])
      expect(result).to.eql({ environmentName: "missing-env" })
    })

    it("should error if an invalid --env parameter is passed", async () => {
      class TestCommand3 extends Command {
        name = "test-command-3"
        help = "halp!"
        noProject = true

        printHeader() {}

        async action({ garden }) {
          return { result: { environmentName: garden.environmentName } }
        }
      }

      const command = new TestCommand3()
      cli.addCommand(command)

      const { errors } = await cli.run({ args: ["test-command-3", "--env", "$.%"], exitOnError: false })

      expect(errors.length).to.equal(1)
      expect(stripAnsi(errors[0].message)).to.equal(
        "Invalid value for option --env: Invalid environment specified ($.%): must be a valid environment name or <namespace>.<environment>"
      )
    })
  })

  describe("makeDummyGarden", () => {
    it("should initialise and resolve config graph in a directory with no project", async () => {
      const path = join(GARDEN_CORE_ROOT, "tmp", "foobarbas")
      await mkdirp(path)
      const garden = await makeDummyGarden(path, {
        commandInfo: { name: "foo", args: {}, opts: {} },
      })
      const dg = await garden.getConfigGraph({ log: garden.log, emit: false })
      expect(garden).to.be.ok
      expect(dg.getModules()).to.not.throw
    })

    it("should correctly configure a dummy environment when a namespace is set", async () => {
      const path = join(GARDEN_CORE_ROOT, "tmp", "foobarbas")
      await mkdirp(path)
      const garden = await makeDummyGarden(path, {
        environmentName: "test.foo",
        commandInfo: { name: "foo", args: {}, opts: {} },
      })
      expect(garden).to.be.ok
      expect(garden.environmentName).to.equal("foo")
    })

    it("should initialise and resolve config graph in a project with invalid config", async () => {
      const root = getDataDir("test-project-invalid-config")
      const garden = await makeDummyGarden(root, { commandInfo: { name: "foo", args: {}, opts: {} } })
      const dg = await garden.getConfigGraph({ log: garden.log, emit: false })
      expect(garden).to.be.ok
      expect(dg.getModules()).to.not.throw
    })

    it("should initialise and resolve config graph in a project with template strings", async () => {
      const root = getDataDir("test-project-templated")
      const garden = await makeDummyGarden(root, { commandInfo: { name: "foo", args: {}, opts: {} } })
      const dg = await garden.getConfigGraph({ log: garden.log, emit: false })
      expect(garden).to.be.ok
      expect(dg.getModules()).to.not.throw
    })
  })

  describe("runtime dependency check", () => {
    describe("validateRuntimeRequirementsCached", () => {
      let config: GlobalConfigStore
      let tmpDir: tmp.DirectoryResult

      before(async () => {
        tmpDir = await tmp.dir({ unsafeCleanup: true })
        config = new GlobalConfigStore(tmpDir.path)
      })

      after(async () => {
        await tmpDir.cleanup()
      })

      afterEach(async () => {
        await config.clear()
      })

      it("should call requirementCheckFunction if requirementsCheck hasn't been populated", async () => {
        const requirementCheckFunction = td.func<() => Promise<void>>()
        await validateRuntimeRequirementsCached(log, config, requirementCheckFunction)

        expect(td.explain(requirementCheckFunction).callCount).to.equal(1)
      })

      it("should call requirementCheckFunction if requirementsCheck hasn't passed", async () => {
        await config.set("requirementsCheck", { passed: false })
        const requirementCheckFunction = td.func<() => Promise<void>>()
        await validateRuntimeRequirementsCached(log, config, requirementCheckFunction)

        expect(td.explain(requirementCheckFunction).callCount).to.equal(1)
      })

      it("should populate config if requirementCheckFunction passes", async () => {
        const requirementCheckFunction = td.func<() => Promise<void>>()
        await validateRuntimeRequirementsCached(log, config, requirementCheckFunction)

        const requirementsCheckConfig = await config.get("requirementsCheck")
        expect(requirementsCheckConfig.passed).to.equal(true)
      })

      it("should not call requirementCheckFunction if requirementsCheck has been passed", async () => {
        await config.set("requirementsCheck", { passed: true })
        const requirementCheckFunction = td.func<() => Promise<void>>()
        await validateRuntimeRequirementsCached(log, config, requirementCheckFunction)

        expect(td.explain(requirementCheckFunction).callCount).to.equal(0)
      })

      it("should throw if requirementCheckFunction throws", async () => {
        async function requirementCheckFunction() {
          throw new Error("broken")
        }

        await expectError(() => validateRuntimeRequirementsCached(log, config, requirementCheckFunction), {
          contains: "broken",
        })
      })
    })
  })
})
