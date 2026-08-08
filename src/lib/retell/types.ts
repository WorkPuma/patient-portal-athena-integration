/** Retell AI webhook event types for the portal scheduling agent */

export interface RetellWebhookEvent {
  event: "call_started" | "call_ended" | "call_analyzed" | "tool_call_result";
  call: RetellCallData;
}

export interface RetellCallData {
  call_id: string;
  call_type: "web_call" | "phone_call";
  agent_id: string;
  from_number?: string;
  to_number?: string;
  direction?: "inbound" | "outbound";
  status: "registered" | "ongoing" | "ended" | "error";
  start_timestamp?: number;
  end_timestamp?: number;
  transcript?: string;
  transcript_object?: TranscriptEntry[];
  call_analysis?: CallAnalysis;
  metadata?: Record<string, string>;
}

export interface TranscriptEntry {
  role: "agent" | "user";
  content: string;
  words?: { word: string; start: number; end: number }[];
}

export interface CallAnalysis {
  call_summary?: string;
  user_sentiment?: "positive" | "negative" | "neutral";
  call_successful?: boolean;
  custom_analysis_data?: Record<string, unknown>;
}

/** Tool request payloads from Retell LLM */

export interface RetellToolRequest {
  call_id: string;
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RetellToolResponse {
  tool_call_id: string;
  result: string;
}

/** Portal scheduling tool argument types */

export interface LookupPatientArgs {
  first_name: string;
  last_name: string;
  date_of_birth: string; // YYYY-MM-DD
  phone?: string;
}

export interface AvailableSlotsArgs {
  department_id?: string;
  provider_id?: string;
  date_from: string; // YYYY-MM-DD
  date_to?: string;
  appointment_type?: string;
}

export interface BookAppointmentArgs {
  patient_id: string;
  /**
   * Slot id returned by `available_slots`. Athena's PUT /appointments/{id}
   * keys on this — NOT on the appointment-type id.
   */
  appointment_id?: string;
  department_id?: string;
  provider_id?: string;
  date?: string;
  time?: string;
  appointment_type_id?: string;
  reason?: string;
}

export interface CurrentAppointmentsArgs {
  patient_id: string;
}

/** Retell LLM configuration for agent creation */

export interface RetellLLMConfig {
  model: string;
  general_prompt: string;
  general_tools: RetellToolDefinition[];
  begin_message?: string;
}

export interface RetellToolDefinition {
  type: "end_call" | "custom";
  name: string;
  description: string;
  url?: string;
  parameters?: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface RetellAgentConfig {
  agent_name: string;
  llm_websocket_url?: string;
  voice_id: string;
  language: string;
  webhook_url?: string;
  ambient_sound?: string;
  responsiveness?: number;
  interruption_sensitivity?: number;
  enable_backchannel?: boolean;
}
