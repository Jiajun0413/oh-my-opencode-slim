import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

/** Raw npm facts shared by the server checker and the TUI notice. Policy
 * (compatible channel, same-major install, notification threshold) is
 * deliberately absent: each consumer derives it with its own rules. */
const facts = z
  .object({
    distTags: z.record(z.string(), z.string()),
    versions: z.array(z.string()),
  })
  .strict();

export const updateFactsRpc = Rpc.define({
  id: 'oh-my-opencode-slim.update-facts.v1',
  methods: {
    get: {
      input: z.object({}).strict(),
      output: z
        .object({
          available: z.boolean(),
          facts: facts.optional(),
        })
        .strict(),
    },
  },
  events: {},
});
