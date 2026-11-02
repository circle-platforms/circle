import type { Tool, ToolCall, Message, PreparedRun } from '../types.js';
import { loadToolPrompt } from '../system_prompt.js';
import { KnowledgeService, type ChangeInput } from './service.js';
import { knowledgeAsset } from '../knowledge_assets.js';
import { requireClean } from './verification.js';

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const expected = {
  type: ['string', 'null'],
  description:
    'Exact local snapshot returned by search; null for an empty space.',
};
/** Reject sensitive proposals before tool calls enter durable history or event logs. No rejected input is echoed. */
export function safeKnowledgeCall(call: ToolCall): ToolCall {
  if (!['knowledge_write', 'memory_write'].includes(call.name)) return call;
  try {
    const serialized = JSON.stringify(call.args);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw Error('knowledge change byte limit');
    requireClean(Buffer.from(serialized));
    if (Array.isArray(call.args.objects))
      for (const object of call.args.objects) {
        if (
          object?.kind === 'bytes' &&
          typeof object.body?.bytes_base64 === 'string'
        )
          requireClean(Buffer.from(object.body.bytes_base64, 'base64'));
      }
    return call;
  } catch {
    return {
      id: call.id,
      name: call.name,
      args: { rejected: true },
      argument_error: 'personal write rejected by credential or size preflight',
    };
  }
}
export function knowledgeTools(service: KnowledgeService): Tool[] {
  const make = (
    name: string,
    effect: Tool['effect'],
    parameters: Record<string, unknown>,
    run: Tool['run'],
  ): Tool => ({
    name,
    effect,
    parameters,
    description: loadToolPrompt(name),
    variables: false,
    subagents: effect === 'read',
    run,
  });
  const search = make(
    'knowledge_search',
    'read',
    schema(
      {
        query: text,
        path: text,
        kind: text,
        status: { enum: ['verified', 'unverified'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: text,
      },
      ['query'],
    ),
    async (args) => JSON.stringify(service.search(String(args.query), args)),
  );
  const read = make(
    'knowledge_read',
    'read',
    schema(
      {
        snapshot: text,
        object: text,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 16000 },
      },
      ['object'],
    ),
    async (args) => {
      if (args.object === 'schema') {
        const offset = Number(args.offset ?? 0),
          limit = Number(args.limit ?? 8000);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 16000
        )
          throw Error('invalid schema read window');
        const text = JSON.stringify(
          knowledgeAsset('personal-sync-object.v1.schema.json'),
        );
        return JSON.stringify({
          schema: 'personal-sync-object@1',
          text: text.slice(offset, offset + limit),
          next: offset + limit < text.length ? offset + limit : null,
        });
      }
      return JSON.stringify(
        service.read(
          String(args.snapshot),
          String(args.object),
          args.offset as number | undefined,
          args.limit as number | undefined,
        ),
      );
    },
  );
  const write = make(
    'knowledge_write',
    'write',
    schema(
      {
        expected_head: expected,
        objects: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: { type: 'object' },
        },
      },
      ['expected_head', 'objects'],
    ),
    async () => {
      throw Error('personal writes require a prepared person approval');
    },
  );
  const memory = make(
    'memory_write',
    'write',
    schema(
      {
        expected_head: expected,
        item_id: text,
        directory_id: text,
        title: text,
        markdown: text,
        state: { enum: ['enabled', 'disabled'] },
        delete: { type: 'boolean' },
      },
      ['expected_head'],
    ),
    write.run,
  );
  for (const tool of [write, memory]) {
    tool.personApproval = true;
    tool.privacy = (call) => {
      const safe = safeKnowledgeCall(call);
      if (safe.argument_error) return safe;
      try {
        if (tool === write)
          service.prepare(call.args as unknown as ChangeInput);
        else
          service.prepareMemory(
            call.args as unknown as Parameters<
              KnowledgeService['prepareMemory']
            >[0],
          );
        return call;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        const safeReason =
          /^(credential rejected:|credential scan incomplete|memory (document|space)|knowledge (change|version)|locked tasks|revision must|identity kind)/.test(
            reason,
          )
            ? reason
            : 'invalid personal revision; read the current version and check its references';
        return {
          id: call.id,
          name: call.name,
          args: { rejected: true },
          argument_error: 'personal write rejected: ' + safeReason,
        };
      }
    };
    tool.prepare = async (args) => {
      const safe = safeKnowledgeCall({ id: '', name: tool.name, args });
      if (safe.argument_error) throw Error(safe.argument_error);
      const prepared =
        tool === write
          ? service.prepare(args as unknown as ChangeInput)
          : service.prepareMemory(
              args as unknown as Parameters<
                KnowledgeService['prepareMemory']
              >[0],
            );
      const run: PreparedRun = async (_args, context) =>
        JSON.stringify({
          snapshot: prepared.commit(context.signal),
          scope: 'local',
          hub_verified: false,
        });
      run.shown = { change: prepared.preview };
      return run;
    };
  }
  const share = make(
    'knowledge_share',
    'write',
    schema({ snapshot: text, object: text, team_path: text }, [
      'snapshot',
      'object',
    ]),
    async () =>
      JSON.stringify({
        available: false,
        reason:
          'Sharing requires Sync to Hub and an authorized Hub entry mapping. Open knowledge sync settings to switch mode. No sync mode was changed; nothing was uploaded.',
      }),
  );
  // Sharing remains unavailable until the authorized mapping/connection stage; no temporary sync or invented endpoint.
  share.approval = false;
  return [search, read, write, memory, share];
}

/** The address/schema reader stays available; other schemas are promoted on knowledge intent or a local read. */
export const deferredKnowledgeTool = (tool: Pick<Tool, 'name'>): boolean =>
  [
    'knowledge_search',
    'knowledge_write',
    'memory_write',
    'knowledge_share',
  ].includes(tool.name);
export function knowledgeToolsWanted(
  messages: readonly Message[],
  prompt: string,
): boolean {
  return (
    /knowledge|memor(?:y|ies)|remember|personal (?:pack|workflow)|知识|记忆|记住|个人(?:工作流|技能|包)/i.test(
      prompt,
    ) ||
    messages.some((message) =>
      message.tool_calls?.some(
        (call) =>
          call.name.startsWith('knowledge_') || call.name === 'memory_write',
      ),
    )
  );
}
