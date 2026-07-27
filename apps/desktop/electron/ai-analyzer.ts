import {
  ConversationAnalysis,
  EMPTY_ANALYSIS,
  Speaker,
  TranscriptSegment,
} from '@transcriber/shared';

export interface AnalyzeInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  speakers: Speaker[];
  segments: TranscriptSegment[];
}

function buildTranscript(speakers: Speaker[], segments: TranscriptSegment[]): string {
  const labels = new Map(speakers.map((s) => [s.id, s.label]));
  return segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${labels.get(s.speakerId) ?? s.speakerId}: ${s.text.trim()}`)
    .join('\n');
}

export async function analyzeConversation(
  input: AnalyzeInput,
): Promise<ConversationAnalysis> {
  const transcript = buildTranscript(input.speakers, input.segments);
  if (!transcript.trim()) {
    return { ...EMPTY_ANALYSIS, updatedAt: new Date().toISOString() };
  }
  if (!input.apiKey.trim()) {
    throw new Error('Add an AI API key in Settings to enable analysis.');
  }

  const base = input.baseUrl.replace(/\/+$/, '') || 'https://api.openai.com/v1';
  const model = input.model.trim() || 'gpt-4o-mini';
  const langHint =
    input.language && input.language !== 'auto'
      ? `Respond in the same language as the conversation when possible (settings language hint: ${input.language}).`
      : 'Respond in the same language as the conversation.';

  const system = `You are a meeting copilot. Analyze the live transcript and help the user follow and participate.
${langHint}
Return ONLY valid JSON with this shape:
{
  "summary": "2-4 sentence plain summary of what is going on",
  "keyPoints": ["short bullet", "..."],
  "suggestedReplies": ["natural reply the user could say next", "..."],
  "openQuestions": ["unresolved question or decision still open", "..."]
}
Rules:
- Keep keyPoints to at most 5 items.
- suggestedReplies: 2-4 concise, natural dialogue suggestions the user (often labeled "You") could say next.
- Be concrete; avoid generic filler.
- If the transcript is thin, say so briefly in summary and give fewer suggestions.`;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Meeting transcript (oldest → newest):\n\n${transcript}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI API error (${res.status}): ${body.slice(0, 280)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? '{}';
  let parsed: Partial<ConversationAnalysis>;
  try {
    parsed = JSON.parse(content) as Partial<ConversationAnalysis>;
  } catch {
    throw new Error('AI returned invalid JSON. Try another model or provider.');
  }

  return {
    summary: String(parsed.summary ?? '').trim(),
    keyPoints: asStringArray(parsed.keyPoints).slice(0, 5),
    suggestedReplies: asStringArray(parsed.suggestedReplies).slice(0, 4),
    openQuestions: asStringArray(parsed.openQuestions).slice(0, 4),
    updatedAt: new Date().toISOString(),
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}
