import Retell from "retell-sdk";

let retellClient: Retell | null = null;

function getRetell(): Retell {
  if (retellClient) return retellClient;
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("RETELL_API_KEY is not configured");
  retellClient = new Retell({ apiKey });
  return retellClient;
}

/**
 * Create a web call for embedded chat in the portal.
 * Returns a call object with the access_token for the client SDK.
 */
export async function createWebCall(opts: {
  agentId: string;
  metadata?: Record<string, string>;
}) {
  const client = getRetell();
  const call = await client.call.createWebCall({
    agent_id: opts.agentId,
    metadata: opts.metadata,
  });
  return call;
}

/**
 * Create an outbound phone call for SMS scheduling agent.
 */
export async function createPhoneCall(opts: {
  agentId: string;
  toNumber: string;
  fromNumber: string;
  metadata?: Record<string, string>;
}) {
  const client = getRetell();
  const call = await client.call.createPhoneCall({
    from_number: opts.fromNumber,
    to_number: opts.toNumber,
    override_agent_id: opts.agentId,
    metadata: opts.metadata,
  });
  return call;
}

/**
 * Retrieve a call by ID (for webhook processing or status checks).
 */
export async function getCall(callId: string) {
  const client = getRetell();
  return client.call.retrieve(callId);
}

/**
 * List all agents.
 */
export async function listAgents() {
  const client = getRetell();
  return client.agent.list();
}

/**
 * Create a new LLM configuration for the portal scheduling agent.
 */
export async function createLLM(opts: {
  model?: string;
  generalPrompt: string;
  generalTools: Array<{
    type: string;
    name: string;
    description: string;
    url?: string;
    parameters?: Record<string, unknown>;
  }>;
  beginMessage?: string;
}) {
  const client = getRetell();
  return client.llm.create({
    model: (opts.model ?? "gpt-4.1") as "gpt-4.1",
    general_prompt: opts.generalPrompt,
    general_tools: opts.generalTools as Parameters<typeof client.llm.create>[0]["general_tools"],
    begin_message: opts.beginMessage,
  });
}

/**
 * Create a new agent tied to an LLM via response_engine.
 */
export async function createAgent(opts: {
  agentName: string;
  llmId: string;
  voiceId: string;
  webhookUrl?: string;
}) {
  const client = getRetell();
  return client.agent.create({
    agent_name: opts.agentName,
    response_engine: {
      type: "retell-llm",
      llm_id: opts.llmId,
    },
    voice_id: opts.voiceId,
    webhook_url: opts.webhookUrl,
    language: "en-US",
    responsiveness: 0.8,
    interruption_sensitivity: 0.7,
    enable_backchannel: true,
  });
}

export { getRetell };
