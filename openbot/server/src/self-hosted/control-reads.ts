import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DemoAppointmentState } from "./appointments";
import { LocalError } from "./errors";
import type { TaskPlanState } from "./plans";

const locale = z.enum(["en-IN", "hi-IN", "ta-IN"]);
const request = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("help"), locale }).strict(),
  z
    .object({
      intent: z.literal("status"),
      locale,
      target: z
        .object({
          kind: z.enum(["demo_appointment", "task_plan"]),
          id: z.uuid(),
        })
        .strict(),
    })
    .strict(),
]);
type Code =
  | "select_slot"
  | "review_approval"
  | "mock_confirmed"
  | "rejected"
  | "cancelled"
  | "approval_expired"
  | "unavailable"
  | "planning"
  | "draft_ready"
  | "needs_clarification"
  | "failed"
  | "interrupted";
const demoCodes: Record<DemoAppointmentState, Code> = {
  AWAITING_SELECTION: "select_slot",
  APPROVAL_PENDING: "review_approval",
  COMPLETED: "mock_confirmed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  EXPIRED: "approval_expired",
  UNAVAILABLE: "unavailable",
};
const planCodes: Record<TaskPlanState, Code> = {
  PLANNING: "planning",
  DRAFT_READY: "draft_ready",
  NEEDS_CLARIFICATION: "needs_clarification",
  UNAVAILABLE: "unavailable",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  CANCELLED: "cancelled",
};
const text = {
  help: [
    "Choose an eligible model for text chat. Use the demo appointment panel to choose a slot and review a simulated booking. Download my text copies conversations and saved preferences. Review saved task information in its own panel. Real speech, bookings, payments and external reminders are not enabled. Use each task's own controls for cancellation; this interface only reads help and status.",
    "टेक्स्ट चैट के लिए उपलब्ध मॉडल चुनें। डेमो अपॉइंटमेंट पैनल में समय चुनकर डेमो बुकिंग की समीक्षा करें। Download my text से बातचीत और सहेजी पसंद की प्रति लें। सहेजे कार्य की जानकारी उसके पैनल में देखें। असली आवाज़ सेवा, बुकिंग, भुगतान और बाहरी रिमाइंडर चालू नहीं हैं। रद्द करने के लिए उसी कार्य के नियंत्रण इस्तेमाल करें; यह इंटरफ़ेस केवल मदद और स्थिति पढ़ता है।",
    "உரை அரட்டைக்கு கிடைக்கும் மாதிரியைத் தேர்ந்தெடுக்கவும். முன்மாதிரி சந்திப்பு பகுதியில் நேரத்தைத் தேர்ந்து, மாதிரி முன்பதிவைச் சரிபார்க்கவும். Download my text மூலம் உரையாடல்களையும் சேமித்த விருப்பங்களையும் பதிவிறக்கலாம். சேமித்த பணியின் விவரங்களை அதன் பகுதியில் பார்க்கவும். உண்மையான குரல் சேவை, முன்பதிவு, கட்டணம் மற்றும் வெளிப்புற நினைவூட்டல்கள் இயக்கப்படவில்லை. ரத்து செய்ய அந்தப் பணியின் கட்டுப்பாடுகளைப் பயன்படுத்தவும்; இங்கு உதவியும் நிலையும் மட்டுமே படிக்கப்படும்.",
  ],
  select_slot: [
    "Choose a demo slot.",
    "डेमो का समय चुनें।",
    "மாதிரி சந்திப்புக்கான நேரத்தைத் தேர்ந்தெடுக்கவும்.",
  ],
  review_approval: [
    "The demo quote awaits your review and approval.",
    "डेमो का विवरण आपकी समीक्षा और अनुमति की प्रतीक्षा में है।",
    "மாதிரி முன்பதிவு விவரங்கள் உங்கள் சரிபார்ப்புக்கும் ஒப்புதலுக்கும் காத்திருக்கின்றன.",
  ],
  mock_confirmed: [
    "The simulated booking is marked confirmed.",
    "डेमो बुकिंग रिकॉर्ड में पुष्टि हुई है।",
    "மாதிரி முன்பதிவு பதிவில் உறுதிசெய்யப்பட்டுள்ளது.",
  ],
  rejected: [
    "The proposal was rejected.",
    "प्रस्ताव अस्वीकार किया गया है।",
    "முன்மொழிவு நிராகரிக்கப்பட்டது.",
  ],
  cancelled: [
    "The task is marked cancelled.",
    "कार्य रिकॉर्ड में रद्द है।",
    "பணி பதிவில் ரத்து செய்யப்பட்டுள்ளது.",
  ],
  approval_expired: [
    "The demo approval has expired. Open the task to review a new selection.",
    "डेमो की अनुमति की समय-सीमा समाप्त है। नया समय चुनने के लिए कार्य खोलें।",
    "மாதிரி ஒப்புதலின் காலம் முடிந்துவிட்டது. புதிய தேர்வைச் சரிபார்க்க பணியைத் திறக்கவும்.",
  ],
  unavailable: [
    "The task is marked unavailable. Open it for details.",
    "कार्य रिकॉर्ड में उपलब्ध नहीं है। विवरण के लिए उसे खोलें।",
    "பணி பதிவில் கிடைக்கவில்லை என உள்ளது. விவரங்களுக்கு பணியைத் திறக்கவும்.",
  ],
  planning: [
    "Draft generation is marked pending.",
    "मसौदा बनना रिकॉर्ड में लंबित है।",
    "வரைவு உருவாக்கம் பதிவில் நிலுவையில் உள்ளது.",
  ],
  draft_ready: [
    "A draft is marked ready. Open the task to review it.",
    "मसौदा रिकॉर्ड में तैयार है। समीक्षा के लिए कार्य खोलें।",
    "வரைவு தயார் என பதிவில் உள்ளது. சரிபார்க்க பணியைத் திறக்கவும்.",
  ],
  needs_clarification: [
    "The draft needs more information. Open the task to review the question.",
    "मसौदे के लिए और जानकारी चाहिए। प्रश्न देखने के लिए कार्य खोलें।",
    "வரைவுக்கு கூடுதல் தகவல் தேவை. கேள்வியைப் பார்க்க பணியைத் திறக்கவும்.",
  ],
  failed: [
    "Draft generation is marked failed. No automatic retry was started.",
    "मसौदा बनना विफल दर्ज है। अपने-आप दोबारा कोशिश शुरू नहीं हुई।",
    "வரைவு உருவாக்கம் தோல்வி என பதிவில் உள்ளது. தானாக மீண்டும் முயற்சி தொடங்கப்படவில்லை.",
  ],
  interrupted: [
    "Draft generation was interrupted. No automatic replay was started.",
    "मसौदा बनना बीच में रुक गया था। अपने-आप दोबारा शुरू नहीं हुआ।",
    "வரைவு உருவாக்கம் இடைநிறுத்தப்பட்டது. தானாக மீண்டும் தொடங்கப்படவில்லை.",
  ],
  mock_notice: [
    "Demo only: no real appointment, payment or notification is confirmed.",
    "यह केवल डेमो है: असली अपॉइंटमेंट, भुगतान या सूचना की पुष्टि नहीं है।",
    "இது மாதிரி மட்டுமே: உண்மையான சந்திப்பு, கட்டணம் அல்லது அறிவிப்பு உறுதிசெய்யப்படவில்லை.",
  ],
  draft_notice: [
    "Stored draft metadata only; this read validates no plan content or external completion.",
    "यह केवल सहेजे मसौदे की स्थिति है; यह पढ़ना सामग्री या बाहरी काम पूरा होने की पुष्टि नहीं करता।",
    "இது சேமித்த வரைவின் நிலைத் தகவல் மட்டுமே; உள்ளடக்கம் அல்லது வெளிப்புற வேலை முடிந்ததை இந்த வாசிப்பு உறுதிசெய்யாது.",
  ],
  pending: [
    "An earlier model result is still pending in the record; this read does not retry or release it.",
    "पहले का मॉडल परिणाम रिकॉर्ड में अभी लंबित है; यह पढ़ना दोबारा कोशिश या उसका आरक्षण समाप्त नहीं करता।",
    "முந்தைய மாதிரி முடிவு பதிவில் இன்னும் நிலுவையில் உள்ளது; இந்த வாசிப்பு மீண்டும் முயற்சி செய்யாது, அதன் ஒதுக்கீட்டையும் விடுவிக்காது.",
  ],
} satisfies Record<
  Code | "help" | "mock_notice" | "draft_notice" | "pending",
  readonly [string, string, string]
>;
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const demoRow = z
  .object({
    state: z.string().min(1).max(32),
    expires: timestamp.nullable(),
    expiry_type: z.enum(["integer", "null"]),
    updated: timestamp,
  })
  .strict();
const planRow = z
  .object({
    state: z.string().min(1).max(32),
    pending: z.union([z.literal(0), z.literal(1)]),
    updated: timestamp,
  })
  .strict();
const unavailable = () => new LocalError("Control status is unavailable.", 503);
function checked<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const p = schema.safeParse(raw);
  if (!p.success) throw unavailable();
  return p.data;
}
function codeFor<T extends string>(codes: Record<T, Code>, state: string) {
  if (!Object.hasOwn(codes, state)) throw unavailable();
  return codes[state as T];
}

/** Read-only owned metadata. No expiry materialization, get/list callbacks, model IO or mutation authority. */
export class ControlReads {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}
  read(
    ownerInput: unknown,
    raw: unknown,
    options: { planningConfigured?: boolean } = {},
  ) {
    const owner = z.uuid().safeParse(ownerInput),
      input = request.safeParse(raw);
    if (!owner.success)
      throw new LocalError(
        "Control reads require an active owner session.",
        403,
      );
    if (!input.success) throw new LocalError("Invalid control-read fields.");
    try {
      return this.db
        .transaction(() => {
          const at = checked(timestamp, this.now()),
            i = ({ "en-IN": 0, "hi-IN": 1, "ta-IN": 2 } as const)[
              input.data.locale
            ];
          const active = (time: number) => {
            if (
              !this.db
                .query(
                  "SELECT 1 FROM sessions s JOIN owners o ON o.id=s.owner WHERE s.owner=? AND typeof(s.expires)='integer' AND s.expires>? LIMIT 1",
                )
                .get(owner.data, time)
            )
              throw new LocalError(
                "Control reads require an active owner session.",
                403,
              );
          };
          active(at);
          const common = {
            format: "saathi-control-read-v1" as const,
            locale: input.data.locale,
            observed_at: at,
            action_executed: false as const,
          };
          if (input.data.intent === "help") {
            active(checked(timestamp, this.now()));
            return {
              ...common,
              intent: "help" as const,
              message: text.help[i],
              supported_intents: ["help", "status"],
              capabilities: {
                demo_appointments: true,
                draft_planning_configured: options.planningConfigured === true,
                text_export: true,
                live_speech: false,
                real_transactions: false,
                external_reminders: false,
              },
            };
          }
          const target = input.data.target;
          let code: Code,
            stored_state: string,
            updated_at: number,
            pending = false;
          if (target.kind === "demo_appointment") {
            const raw = this.db
              .query(
                "SELECT CASE WHEN length(CAST(state AS BLOB))<=32 THEN state END state,CASE WHEN typeof(expires)='integer' THEN expires ELSE NULL END expires,typeof(expires) expiry_type,CASE WHEN typeof(updated)='integer' THEN updated END updated FROM demo_tasks WHERE id=? AND owner=?",
              )
              .get(target.id, owner.data);
            if (!raw) throw new LocalError("Task status not found.", 404);
            const r = checked(demoRow, raw);
            code = codeFor(demoCodes, r.state);
            stored_state = r.state;
            updated_at = r.updated;
            if (r.state === "APPROVAL_PENDING") {
              if (r.expires === null || r.expires === 0) throw unavailable();
              if (r.expires <= at) code = "approval_expired";
            }
          } else {
            const raw = this.db
              .query(
                "SELECT CASE WHEN length(CAST(state AS BLOB))<=32 THEN state END state,CASE WHEN typeof(pending)='integer' THEN pending END pending,CASE WHEN typeof(updated)='integer' THEN updated END updated FROM task_plans WHERE id=? AND owner=?",
              )
              .get(target.id, owner.data);
            if (!raw) throw new LocalError("Task status not found.", 404);
            const r = checked(planRow, raw);
            code = codeFor(planCodes, r.state);
            stored_state = r.state;
            updated_at = r.updated;
            pending = r.pending === 1;
            if (
              (r.state === "PLANNING" && !pending) ||
              (r.state !== "PLANNING" && r.state !== "CANCELLED" && pending)
            )
              throw unavailable();
          }
          active(checked(timestamp, this.now()));
          const mode =
            target.kind === "demo_appointment"
              ? ("mock" as const)
              : ("draft_only" as const);
          return {
            ...common,
            intent: "status" as const,
            target,
            evidence_scope: "stored_task_metadata" as const,
            status: { mode, stored_state, code, pending, updated_at },
            message: text[code][i],
            notice: text[mode === "mock" ? "mock_notice" : "draft_notice"][i],
            pending_note: pending ? text.pending[i] : null,
          };
        })
        .deferred();
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw unavailable();
    }
  }
}
