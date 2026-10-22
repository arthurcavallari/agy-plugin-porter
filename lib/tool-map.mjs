// Source tool names -> agy tool names. Claude's comes from `agy plugin validate`
// 1.4.5 (docs/agy-baseline.md, "Tool names"); where the CLI and the IDE name a
// tool differently, both are listed. scripts/hook-shim.mjs keeps its own reverse
// copy because it ships alone inside each ported plugin.
export const TOOLS = {
  claude: {
    Bash: ['run_command'],
    Read: ['view_file', 'read_file'],
    Write: ['write_to_file', 'write_file'],
    Edit: ['replace_file_content', 'edit_file'],
    MultiEdit: ['multi_replace_file_content', 'edit_file'],
    Grep: ['grep_search'],
    Glob: ['find_by_name'],
    LS: ['list_dir'],
    WebFetch: ['read_url_content'],
    WebSearch: ['search_web'],
    NotebookEdit: ['notebook_edit'],
    Task: ['invoke_subagent'],
    Agent: ['invoke_subagent'],
  },
  gemini: {
    run_shell_command: ['run_command'],
    read_file: ['view_file', 'read_file'],
    write_file: ['write_to_file', 'write_file'],
    replace: ['replace_file_content', 'edit_file'],
    glob: ['find_by_name'],
    search_file_content: ['grep_search'],
    list_directory: ['list_dir'],
    web_fetch: ['read_url_content'],
    google_web_search: ['search_web'],
  },
};

export const AGY_TOOLS = new Set(Object.values(TOOLS).flatMap((m) => Object.values(m).flat()));

// Roo/Kilo/Cline mode tool groups.
export const ROO_GROUPS = {
  read: ['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name'],
  edit: ['write_to_file', 'write_file', 'replace_file_content', 'edit_file', 'multi_replace_file_content'],
  command: ['run_command'],
};

export function unmappedToolReason(name) {
  if (name.startsWith('mcp__')) return 'MCP tool names are not mapped yet (agy MCP step names are unverified)';
  if (name === 'TodoWrite' || /^Task(Create|Get|List|Update|Output|Stop)$/.test(name)) return 'agy has no built-in tool that does the same job';
  return 'no agy tool with this name';
}
