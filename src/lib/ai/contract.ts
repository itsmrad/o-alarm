// The Edge Function contract (request/response schemas), shared with the server so the two can
// never drift. The file is pure TypeScript + zod.
export {
  aiExplanationSchema,
  aiRequestSchema,
  aiResponseSchema,
  type AiExplanation,
  type AiRequest,
  type AiResponse,
} from '../../../supabase/functions/ai-insights/core';
