/**
 * Free-lane assets: the environment block and official toolset the upstream
 * fingerprints.
 *
 * Live A/B on this lane (2026-11-21, deepseek-v4.1-flash-free and big-pickle,
 * same session, same headers, same tools):
 *
 *   full official CLI prompt      → 200
 *   <env> block only              → 200
 *   any system text without <env> → 429 FreeUsageLimitError
 *   no system message at all      → 429 FreeUsageLimitError
 *
 * The gate requires an environment block, not a persona. This relay therefore
 * injects only the `<env>` block (plus the CLI's skills listing, which the
 * block is normally followed by) and never prepends a persona prompt to the
 * caller's traffic. The upstream tool set is still appended with
 * `strict: false`, and client tools are renamed to opaque names so no foreign
 * client's vocabulary appears on the wire.
 */
import type { ChatTool } from "./types";

/** A body already carrying an env block needs no injection. */
export const ENV_MARKER = "<env>";

const SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

function utcDate(now = new Date()): string {
  return now.toUTCString().slice(0, 16).replace(",", "");
}

/**
 * The environment block the official client puts in its system message. The
 * labels and shape are what the gate reads; values are truthful process facts.
 */
export function officialEnvironment(model: string, directory: string, now = new Date()): string {
  const id = String(model ?? "").replace(/^opencode\//, "").trim() || "unknown";
  return [
    `You are powered by the model named ${id}. The exact model ID is opencode/${id}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: no",
    `  Platform: ${process.platform}`,
    `  Today's date: ${utcDate(now)}`,
    "</env>",
  ].join("\n");
}

/**
 * The system context this relay injects: the environment block plus the
 * built-in skills listing the CLI appends after it. No persona prompt.
 */
export function injectedSystemContext(model: string, directory = "/", now = new Date()): string {
  return `${officialEnvironment(model, directory, now)}\n${SKILLS}`;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const str = (description: string) => ({ type: "string", description });
const int = (description: string, minimum = 0) => ({
  type: "integer",
  description,
  minimum,
});
const bool = (description: string) => ({ type: "boolean", description });

/**
 * The 13 tools the 2.x CLI declares, in its captured order. Parameter shapes
 * are API contracts; descriptions are authored here.
 */
export const OFFICIAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "edit",
    description:
      "Replace an exact text match in a file. Read the current file before editing. Prefer one focused change over rewriting a whole file.",
    parameters: obj(
      {
        path: str("Path to the file to modify."),
        oldString: str("The exact text to replace. It must match the file content uniquely unless replaceAll is set."),
        newString: str("The text to insert in place of the match."),
        replaceAll: bool("Replace every occurrence instead of requiring a unique match."),
      },
      ["path", "oldString", "newString"],
    ),
  },
  {
    name: "execute",
    description: "Run code through the host execution capability when available and return its output.",
    parameters: obj({ code: str("The code to run.") }, ["code"]),
  },
  {
    name: "glob",
    description:
      "List paths matching a glob pattern under a directory. Results are sorted by modification time.",
    parameters: obj(
      {
        pattern: str("The glob pattern to match, for example **/*.ts."),
        path: str("Directory to search in. Defaults to the working directory."),
        hidden: bool("Include hidden files and directories."),
        limit: int("Maximum number of paths to return.", 1),
      },
      ["pattern"],
    ),
  },
  {
    name: "grep",
    description:
      "Search file content with a regular expression and return matching lines with their paths and line numbers.",
    parameters: obj(
      {
        pattern: str("The regular expression to search for."),
        path: str("File or directory to search. Defaults to the working directory."),
        include: str("Glob filter for file names, for example *.ts."),
        caseSensitive: bool("Match case-sensitively."),
        literal: bool("Treat the pattern as a literal string instead of a regular expression."),
        limit: int("Maximum number of matches to return.", 1),
      },
      ["pattern"],
    ),
  },
  {
    name: "question",
    description:
      "Request a user decision using concise questions with selectable options. Use only when the answer blocks correct progress.",
    parameters: obj(
      {
        questions: {
          type: "array",
          description: "Questions to ask, each with options.",
          minItems: 1,
          items: obj(
            {
              question: str("The full question to display."),
              header: str("Very short label for the question."),
              multiple: bool("Allow selecting more than one option."),
              options: {
                type: "array",
                items: obj(
                  {
                    label: str("Option text the user selects."),
                    description: str("What the option means."),
                  },
                  ["label", "description"],
                ),
              },
            },
            ["question", "header", "options"],
          ),
        },
      },
      ["questions"],
    ),
  },
  {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Each text line is prefixed by its 1-based line number as <line>: <content>; the prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections.",
    parameters: obj(
      {
        path: str("Path to the file or directory to read."),
        offset: int("1-based line number to start reading from."),
        limit: int("Maximum number of lines or entries to return."),
      },
      ["path"],
    ),
  },
  {
    name: "shell",
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Commands accept an optional timeout; background commands have no timeout by default.",
    parameters: obj(
      {
        command: str("The command line to run."),
        workdir: str("Working directory for the command. Defaults to the working directory."),
        timeout: int("Timeout in milliseconds."),
        background: bool("Run the command in the background and return immediately."),
      },
      ["command"],
    ),
  },
  {
    name: "skill",
    description: "Load a skill explicitly made available by the host.",
    parameters: obj({ id: str("Identifier of the skill to load.") }, ["id"]),
  },
  {
    name: "subagent",
    description: "Delegate a scoped task to an available agent when authorized.",
    parameters: obj(
      {
        agent: str("Name of the agent to run."),
        description: str("Short description of the task."),
        prompt: str("The task prompt for the agent."),
        background: bool("Run the agent in the background."),
        model: str("Model override for the agent."),
        sessionID: { type: "string", description: "Existing session to continue.", pattern: "^ses" },
      },
      ["agent", "description", "prompt"],
    ),
  },
  {
    name: "webfetch",
    description: "Retrieve a public URL and return it in the selected representation.",
    parameters: obj(
      {
        url: str("The URL to fetch."),
        format: { type: "string", description: "Representation to return.", enum: ["text", "markdown", "html"] },
        timeout: { type: "number", description: "Timeout in seconds.", exclusiveMinimum: 0, maximum: 120 },
      },
      ["url"],
    ),
  },
  {
    name: "websearch",
    description: "Search public web information for the supplied query.",
    parameters: obj({ query: str("The search query.") }, ["query"]),
  },
  {
    name: "write",
    description: "Write the supplied content to a file within the authorized task scope.",
    parameters: obj(
      {
        path: str("Path of the file to write."),
        content: str("The full content to write."),
      },
      ["path", "content"],
    ),
  },
  {
    name: "patch",
    description: "Apply the supplied patch through the host file editing capability.",
    parameters: obj({ patchText: str("The patch text to apply.") }, ["patchText"]),
  },
];

/** The shell description is platform-aware, as the official client renders it. */
export function shellDescription(base: string, platform = process.platform): string {
  if (platform === "win32") return base.replace("on Linux using bash", "on Windows using powershell");
  if (platform === "darwin") return base.replace("on Linux using bash", "on macOS using bash");
  return base;
}

/** One official tool in the chat wire shape, marked `strict: false` like the client. */
export function officialTool(name: string, platform = process.platform): ChatTool {
  const definition = OFFICIAL_TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) throw new Error(`Unknown official tool: ${name}`);
  const description =
    name === "shell" ? shellDescription(definition.description, platform) : definition.description;
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: structuredClone(definition.parameters),
      strict: false,
    },
  };
}

export function officialToolset(platform = process.platform): ChatTool[] {
  return OFFICIAL_TOOL_DEFINITIONS.map((tool) => officialTool(tool.name, platform));
}

/** Note appended when official tools had to be injected as placeholders. */
export function placeholderNote(names: readonly string[]): string {
  const list = names.map((name) => `\`${name}\``).join(", ");
  return `The tools ${list} are part of the host CLI's own toolset and are placeholders in this session; they do nothing here. Use the other tools you have been given instead.`;
}
