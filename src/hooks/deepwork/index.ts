import { stripFrontmatter } from '../../cli/custom-skills';
import skillMarkdown from '../../skills/deepwork/SKILL.md' with {
  type: 'text',
};
import { createInternalAgentTextPart } from '../../utils';
import { registerCommandHook } from '../command-hook-utils';

const COMMAND_NAME = 'deepwork';

// SKILL.md is the single contract source. deepwork ships as command-injected
// content rather than a resident skill (#1332): the body is bundled at build
// time and reaches model context only when /deepwork runs. Same posture the
// registry sanctions for loop-engineering, minus the duplication — the
// injected text is the SKILL.md body itself.
const instructions = stripFrontmatter(skillMarkdown).trim();

function activationPrompt(task: string, sessionID: string): string {
  return [
    instructions,
    '',
    `Your deepwork state file is \`.slim/deepwork/${sessionID}.md\` — create/update only this file.`,
    '',
    'Task:',
    task,
  ].join('\n');
}

export function createDeepworkCommandHook(): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
} {
  return {
    registerCommand: (opencodeConfig) => {
      registerCommandHook(
        opencodeConfig,
        COMMAND_NAME,
        'Start a deepwork session for a complex coding task',
        'Use the deepwork workflow for heavy multi-phase coding work',
      );
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      output.parts.length = 0;
      const task = input.arguments.trim();
      if (!task) {
        output.parts.push(
          createInternalAgentTextPart(
            'What task should deepwork manage? Run `/deepwork <task>`.',
          ),
        );
        return;
      }

      output.parts.push({
        type: 'text',
        text: activationPrompt(task, input.sessionID),
      });
    },
  };
}
