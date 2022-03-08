---
order: 1
title: Project configuration context
---

# Project configuration context

The following keys are available in any template strings within Project configurations, except the `name` field (which cannot be templated). See the [Environment](./environments.md) and [Provider](./providers.md) sections for additional keys available when configuring `environments` and `providers`, respectively.

### `${local.*}`

Context variables that are specific to the currently running environment/machine.

| Type     |
| -------- |
| `object` |

### `${local.artifactsPath}`

The absolute path to the directory where exported artifacts from test and task runs are stored.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${local.artifactsPath}
```

### `${local.env.*}`

A map of all local environment variables (see https://nodejs.org/api/process.html#process_process_env).

| Type     |
| -------- |
| `object` |

### `${local.env.<env-var-name>}`

The environment variable value.

| Type     |
| -------- |
| `string` |

### `${local.platform}`

A string indicating the platform that the framework is running on (see https://nodejs.org/api/process.html#process_process_platform)

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${local.platform}
```

### `${local.projectPath}`

The absolute path to the project root directory.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${local.projectPath}
```

### `${local.username}`

The current username (as resolved by https://github.com/sindresorhus/username).

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${local.username}
```

### `${local.usernameLowerCase}`

The current username (as resolved by https://github.com/sindresorhus/username), with any upper case characters converted to lower case.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${local.usernameLowerCase}
```

### `${command.*}`

Information about the currently running command and its arguments.

| Type     |
| -------- |
| `object` |

### `${command.name}`

The currently running Garden CLI command, without positional arguments or option flags. This can be handy to e.g. change some variables based on whether you're running `garden test` or some other specific command.

Note that this will currently always resolve to `"run workflow"` when running Workflows, as opposed to individual workflow step commands. This may be revisited at a later time, but currently all configuration is resolved once for all workflow steps.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${command.name}
```

### `${command.params.*}`

A map of all parameters set when calling the current command. This includes both positional arguments and option flags, and includes any default values set by the framework or specific command. This can be powerful if used right, but do take care since different parameters are only available in certain commands, some have array values etc.

For example, to see if a service is in hot-reload mode, you might do something like `${command.params contains 'hot-reload' && command.params.hot-reload contains 'my-service'}`. Notice that you currently need to check both for the existence of the parameter, and also to correctly handle the array value.

Option values can be referenced by the option's default name (e.g. `dev-mode`) or its alias (e.g. `dev`) if one is defined for that option.

| Type     |
| -------- |
| `object` |

### `${command.params.<name>}`

| Type  |
| ----- |
| `any` |

### `${datetime.*}`

Information about the date/time at template resolution time.

| Type     |
| -------- |
| `object` |

### `${datetime.now}`

The current UTC date and time, at time of template resolution, in ISO-8601 format.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${datetime.now}
```

### `${datetime.today}`

The current UTC date, at time of template resolution, in ISO-8601 format.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${datetime.today}
```

### `${datetime.timestamp}`

The current UTC Unix timestamp (in seconds), at time of template resolution.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${datetime.timestamp}
```

### `${project.*}`

Information about the Garden project.

| Type     |
| -------- |
| `object` |

### `${project.name}`

The name of the Garden project.

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${project.name}
```

### `${git.*}`

Information about the current state of the project's Git repository.

| Type     |
| -------- |
| `object` |

### `${git.branch}`

The current Git branch, if available. Resolves to an empty string if HEAD is in a detached state
(e.g. when rebasing), or if the repository has no commits.

When using remote sources, the branch used is that of the project/top-level repository (the one that contains
the project configuration).

The branch is resolved at the start of the Garden command's execution, and is not updated if the current branch changes during the command's execution (which could happen, for example, when using watch-mode commands).

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${git.branch}
```

### `${git.commitHash}`

The current Git commit hash, if available. Resolves to an empty string if the repository has no commits.

When using remote sources, the hash used is that of the project/top-level repository (the one that contains the project configuration).

The hash is resolved at the start of the Garden command's execution, and is not updated if the current commit changes during the command's execution (which could happen, for example, when using watch-mode commands).

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${git.commitHash}
```

### `${git.originUrl}`

The remote origin URL of the project Git repository.

When using remote sources, the URL is that of the project/top-level repository (the one that contains the project configuration).

| Type     |
| -------- |
| `string` |

Example:

```yaml
my-variable: ${git.originUrl}
```

### `${secrets.<secret-name>}`

The secret's value.

| Type     |
| -------- |
| `string` |
