ALTER TABLE "saathi_model_keys" DROP CONSTRAINT "saathi_model_provider";--> statement-breakpoint
ALTER TABLE "saathi_preferences" DROP CONSTRAINT "saathi_preference_provider";--> statement-breakpoint
ALTER TABLE "saathi_model_keys" ADD CONSTRAINT "saathi_model_provider" CHECK ("saathi_model_keys"."provider" in ('openai', 'anthropic', 'meta'));--> statement-breakpoint
ALTER TABLE "saathi_preferences" ADD CONSTRAINT "saathi_preference_provider" CHECK ("saathi_preferences"."provider" in ('openai', 'anthropic', 'meta'));