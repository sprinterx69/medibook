// ─────────────────────────────────────────────────────────────────────────────
// services/llm.js
//
// GPT-4o integration with tool calling.
// The LLM has access to 5 tools:
//   check_availability   — query open slots for a service/date
//   book_appointment     — create a booking in the database
//   cancel_appointment   — cancel an existing booking
//   reschedule_appointment — move a booking to a new slot
//   get_clinic_info      — return FAQs, hours, pricing
//
// Tool calls are executed server-side (we call the real DB/API),
// then the results are fed back to GPT-4o which formulates the spoken response.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import { checkAvailability } from './calendar.js';
import { bookAppointment, cancelAppointment, rescheduleAppointment } from './booking.js';
import { getClinicInfo } from './tenant-and-utils.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Check available appointment slots for a given service, optional staff member, and date. Use this before booking to show the caller options.',
      parameters: {
        type: 'object',
        properties: {
          service_name: {
            type: 'string',
            description: 'The name of the service (e.g. "Hydrafacial", "Botox", "Laser Treatment")',
          },
          date: {
            type: 'string',
            description: 'The date to check in ISO format YYYY-MM-DD, or relative like "tomorrow", "next Monday"',
          },
          staff_preference: {
            type: 'string',
            description: 'Optional: preferred staff member name',
          },
        },
        required: ['service_name', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Book an appointment for the caller after they have confirmed a slot. Always call check_availability first and confirm details with the caller before booking.',
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'The service to book' },
          slot_id:      { type: 'string', description: 'The slot ID returned by check_availability' },
          client_name:  { type: 'string', description: 'The caller\'s full name' },
          client_phone: { type: 'string', description: 'The caller\'s phone number' },
          notes:        { type: 'string', description: 'Any special notes or requests from the caller' },
        },
        required: ['service_name', 'slot_id', 'client_name', 'client_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancel an existing appointment. Ask the caller for their name and/or phone number to look up the booking.',
      parameters: {
        type: 'object',
        properties: {
          client_phone: { type: 'string', description: 'The caller\'s phone number to look up their booking' },
          appointment_id: { type: 'string', description: 'The specific appointment ID if known' },
          reason: { type: 'string', description: 'Reason for cancellation (optional)' },
        },
        required: ['client_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reschedule an existing appointment to a new date/time. First find the existing booking using the caller\'s phone number, then check availability for the new time.',
      parameters: {
        type: 'object',
        properties: {
          client_phone:    { type: 'string', description: 'Caller\'s phone number to look up their booking' },
          appointment_id:  { type: 'string', description: 'The appointment ID to reschedule' },
          new_slot_id:     { type: 'string', description: 'The new slot ID from check_availability' },
        },
        required: ['client_phone', 'new_slot_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_clinic_info',
      description: 'Get information about the clinic: services offered, prices, opening hours, location, and frequently asked questions.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['services', 'pricing', 'hours', 'location', 'faqs', 'all'],
            description: 'What information to retrieve',
          },
        },
        required: ['topic'],
      },
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────
async function executeTool(toolName, args, session) {
  switch (toolName) {
    case 'check_availability':
      return checkAvailability({
        tenantId: session.tenantId,
        serviceName: args.service_name,
        date: args.date,
        staffPreference: args.staff_preference,
      });

    case 'book_appointment':
      return bookAppointment({
        tenantId: session.tenantId,
        serviceName: args.service_name,
        slotId: args.slot_id,
        clientName: args.client_name,
        clientPhone: args.client_phone,
        notes: args.notes,
      });

    case 'cancel_appointment':
      return cancelAppointment({
        tenantId: session.tenantId,
        clientPhone: args.client_phone,
        appointmentId: args.appointment_id,
        reason: args.reason,
      });

    case 'reschedule_appointment':
      return rescheduleAppointment({
        tenantId: session.tenantId,
        clientPhone: args.client_phone,
        appointmentId: args.appointment_id,
        newSlotId: args.new_slot_id,
      });

    case 'get_clinic_info':
      return getClinicInfo({ tenantId: session.tenantId, topic: args.topic });

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────
function buildSystemPrompt(tenantContext) {
  const { name, services, hours, location } = tenantContext;

  return `You are a friendly, professional AI receptionist for ${name}, a premium medical aesthetics clinic.

Your job is to:
- Answer incoming calls and greet callers warmly
- Help callers book, reschedule, or cancel appointments
- Answer questions about services, pricing, and opening hours
- Always be concise — this is a phone call, not a chat. Keep responses under 3 sentences unless listing options.

CLINIC DETAILS:
- Name: ${name}
- Location: ${location ?? 'Central London'}
- Hours: ${hours ?? 'Monday–Saturday 9am–7pm'}
- Services: ${services?.map(s => s.name).join(', ') ?? 'Hydrafacial, Botox, Laser Treatments, Dermal Fillers, Chemical Peels'}

RULES:
1. ALWAYS confirm the caller's name before booking.
2. ALWAYS call check_availability before booking — never invent slots.
3. ALWAYS read back the full booking details (service, date, time, practitioner) before confirming.
4. If the caller wants to speak to a human, say: "Of course, let me transfer you now" and end with [TRANSFER].
5. If you don't know something, say "Let me check that for you" and use a tool.
6. Be warm and professional. Treat every caller as a valued client.
7. For sensitive medical questions, refer callers to speak with a practitioner.
8. Keep your voice responses natural and conversational — no bullet points or lists.

CURRENT DATE/TIME: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;
}

// ─── Main LLM Turn ────────────────────────────────────────────────────────────
/**
 * Runs a single conversation turn through GPT-4o.
 * Handles multi-step tool calling: the LLM may call multiple tools before
 * producing a final spoken response.
 *
 * @returns {{ responseText: string, toolResults: Array, updatedHistory: Array }}
 */
export async function runLLMTurn({ session, userText, log }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(session.tenantContext) },
    ...session.conversationHistory,
  ];

  const toolResults = [];
  let responseText = null;
  const updatedHistory = [...session.conversationHistory];

  // ── Agentic loop: keep calling the LLM until it produces a text response ──
  let iterations = 0;
  const MAX_ITERATIONS = 6; // Safety limit

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.4,      // Slightly creative but consistent
      max_tokens: 400,       // Keep responses concise for voice
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Add assistant message to history
    messages.push(assistantMessage);
    updatedHistory.push(assistantMessage);

    // ── If the LLM wants to call tools ────────────────────────────────────
    if (choice.finish_reason === 'tool_calls' && assistantMessage.tool_calls) {
      log.debug({ tools: assistantMessage.tool_calls.map(t => t.function.name) }, 'LLM requested tool calls');

      // Execute all tool calls in parallel
      const toolCallPromises = assistantMessage.tool_calls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        log.info({ tool: toolName, args }, 'Executing tool');
        const result = await executeTool(toolName, args, session);
        log.info({ tool: toolName, resultPreview: JSON.stringify(result).slice(0, 100) }, 'Tool result');

        toolResults.push({ name: toolName, args, result });

        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      });

      const toolMessages = await Promise.all(toolCallPromises);

      // Add tool results back to the conversation
      messages.push(...toolMessages);
      updatedHistory.push(...toolMessages);
      continue; // Loop back — LLM will now formulate a response with tool results
    }

    // ── LLM produced a text response ──────────────────────────────────────
    if (assistantMessage.content) {
      responseText = assistantMessage.content;

      // Check for escalation signal
      if (responseText.includes('[TRANSFER]')) {
        responseText = responseText.replace('[TRANSFER]', '').trim();
        session.shouldTransfer = true;
        log.info({ callSid: session.callSid }, 'Transfer requested by LLM');
      }
      break;
    }

    break; // Unexpected finish reason — exit loop
  }

  return { responseText, toolResults, updatedHistory };
}
