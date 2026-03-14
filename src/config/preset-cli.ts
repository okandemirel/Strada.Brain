/**
 * Preset CLI Commands — manage system presets from the command line.
 *
 * Commands: preset list, preset set <name>, preset show <name>
 */

import { Command } from "commander";
import { listPresets, getPreset, PROVIDER_MODEL_OPTIONS } from "./presets.js";

export function registerPresetCommands(program: Command): void {
  const preset = program
    .command("preset")
    .description("Manage system presets for provider/model configuration");

  preset
    .command("list")
    .description("List all available presets")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const presets = listPresets();
      if (opts.json) {
        console.log(JSON.stringify(presets, null, 2));
        return;
      }
      console.log("\nAvailable System Presets:\n");
      for (const p of presets) {
        console.log(`  ${p.name.padEnd(14)} ${p.label.padEnd(22)} ${p.description}`);
      }
      console.log("\nUsage: Set SYSTEM_PRESET=<name> in your .env file");
      console.log("       or run: strada-brain preset set <name>\n");
    });

  preset
    .command("show <name>")
    .description("Show detailed configuration for a preset")
    .option("--json", "Output as JSON")
    .action((name: string, opts: { json?: boolean }) => {
      const p = getPreset(name);
      if (!p) {
        console.error(`Unknown preset: "${name}". Run "strada-brain preset list" to see options.`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }

      console.log(`\n${p.label}`);
      console.log(`${"─".repeat(40)}`);
      console.log(`  Description:    ${p.description}`);
      console.log(`  Est. Cost:      ${p.estimatedMonthlyCost}/month`);
      console.log(`  Provider Chain: ${p.providerChain}`);
      console.log(`  Models:`);
      for (const [provider, model] of Object.entries(p.providerModels)) {
        console.log(`    ${provider}: ${model}`);
      }
      console.log(`  Delegation:`);
      console.log(`    Local:    ${p.delegationTierLocal}`);
      console.log(`    Cheap:    ${p.delegationTierCheap}`);
      console.log(`    Standard: ${p.delegationTierStandard}`);
      console.log(`    Premium:  ${p.delegationTierPremium}`);
      console.log(`  Embedding:  ${p.embeddingProvider} / ${p.embeddingModel}`);
      console.log(`  Pricing:`);
      console.log(`    Chat:      $${p.pricing.chat.input}/$${p.pricing.chat.output} per 1M (${p.pricing.chat.model})`);
      console.log(`    Embedding: $${p.pricing.embedding.perMillion} per 1M (${p.pricing.embedding.model})`);
      console.log();
    });

  preset
    .command("set <name>")
    .description("Set the active system preset (writes to .env)")
    .action(async (name: string) => {
      const p = getPreset(name);
      if (!p) {
        console.error(`Unknown preset: "${name}". Run "strada-brain preset list" to see options.`);
        process.exit(1);
      }

      const { readFileSync, writeFileSync } = await import("node:fs");
      const envPath = ".env";
      let envContent = "";
      try { envContent = readFileSync(envPath, "utf-8"); } catch { /* new file */ }

      // Update or add SYSTEM_PRESET
      const presetLine = `SYSTEM_PRESET=${name}`;
      if (/^SYSTEM_PRESET=/m.test(envContent)) {
        envContent = envContent.replace(/^SYSTEM_PRESET=.*$/m, presetLine);
      } else {
        envContent = envContent.trimEnd() + "\n" + presetLine + "\n";
      }

      writeFileSync(envPath, envContent);
      console.log(`\nPreset set to "${name}" (${p.label})`);
      console.log(`Estimated cost: ${p.estimatedMonthlyCost}/month`);
      console.log("Restart Strada Brain to apply.\n");
    });

  preset
    .command("models [provider]")
    .description("Show available models for a provider (or all providers)")
    .option("--json", "Output as JSON")
    .action((provider: string | undefined, opts: { json?: boolean }) => {
      const providers = provider ? [provider] : Object.keys(PROVIDER_MODEL_OPTIONS);

      if (opts.json) {
        const result = provider
          ? PROVIDER_MODEL_OPTIONS[provider] ?? []
          : PROVIDER_MODEL_OPTIONS;
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const prov of providers) {
        const models = PROVIDER_MODEL_OPTIONS[prov];
        if (!models || models.length === 0) continue;
        console.log(`\n${prov}:`);
        for (const m of models) {
          const tier = m.tier.padEnd(9);
          const price = `$${m.inputPer1M}/$${m.outputPer1M}`.padEnd(12);
          console.log(`  ${m.model.padEnd(50)} ${tier} ${price} ${m.notes}`);
        }
      }
      console.log();
    });
}
