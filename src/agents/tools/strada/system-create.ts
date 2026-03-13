import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { STRADA_API } from "../../context/strada-api-reference.js";

export class SystemCreateTool implements ITool {
  readonly name = "strada_create_system";
  readonly description =
    "Create a new ECS System for Strada.Core. Systems process entities with specific component queries. " +
    "Supports SystemBase (standard), JobSystemBase (Burst-compiled), and BurstSystem (generic Burst with 1-4 component type args).";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "System class name (e.g., 'MovementSystem', 'DamageSystem')",
      },
      path: {
        type: "string",
        description: "Relative file path (e.g., 'Assets/Modules/Combat/Systems/DamageSystem.cs')",
      },
      namespace: {
        type: "string",
        description: "C# namespace (e.g., 'Game.Modules.Combat')",
      },
      base_class: {
        type: "string",
        enum: STRADA_API.baseClasses.systems,
        description: "Base class to inherit from: SystemBase (standard) or JobSystemBase (Burst-compiled). For generic BurstSystem, use SystemBase and set burst_component_count. Default: SystemBase",
      },
      burst_component_count: {
        type: "number",
        description: "Number of component type args for generic BurstSystem (1-4). When set, generates a BurstSystem<TJob, T1, ...> instead of the base_class. Requires query_components to match the count.",
      },
      query_components: {
        type: "array",
        items: { type: "string" },
        description: "Component types this system queries (e.g., ['Health', 'Position'])",
      },
      inject_services: {
        type: "array",
        items: { type: "string" },
        description: "Services to inject via [Inject] attribute. Note: field injection in systems is non-standard; prefer constructor injection in services.",
      },
      system_order: {
        type: "number",
        description: "Execution order via [ExecutionOrder] attribute. Default: 0",
      },
      update_phase: {
        type: "string",
        enum: STRADA_API.updatePhases,
        description: "Optional update phase override. If omitted, Strada.Core defaults to Update.",
      },
      run_before: {
        type: "array",
        items: { type: "string" },
        description: "Systems that should run after this one (e.g., ['RenderSystem'])",
      },
      run_after: {
        type: "array",
        items: { type: "string" },
        description: "Systems that should run before this one (e.g., ['PhysicsSystem'])",
      },
      requires_system: {
        type: "array",
        items: { type: "string" },
        description: "Systems this one depends on (e.g., ['InputSystem'])",
      },
    },
    required: ["name", "path", "namespace"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: system creation is disabled in read-only mode",
        isError: true,
      };
    }

    const rawName = String(input["name"] ?? "");
    const name = rawName.endsWith("System") ? rawName : rawName + "System";
    const relPath = String(input["path"] ?? "");
    const namespace = String(input["namespace"] ?? "");
    const baseClass = String(input["base_class"] ?? "SystemBase");
    const queryComponents = (input["query_components"] as string[]) ?? [];
    const injectServices = (input["inject_services"] as string[]) ?? [];
    const burstComponentCount = typeof input["burst_component_count"] === "number" ? input["burst_component_count"] : undefined;
    const systemOrder = typeof input["system_order"] === "number" ? input["system_order"] : 0;
    const updatePhase = String(input["update_phase"] ?? "");
    const runBefore = (input["run_before"] as string[]) ?? [];
    const runAfter = (input["run_after"] as string[]) ?? [];
    const requiresSystem = (input["requires_system"] as string[]) ?? [];

    if (!name || !relPath || !namespace) {
      return {
        content: "Error: name, path, and namespace are required",
        isError: true,
      };
    }

    // Validate identifiers
    if (!isValidCSharpIdentifier(name)) {
      return { content: "Error: invalid system name", isError: true };
    }
    if (!isValidCSharpIdentifier(namespace, true)) {
      return { content: "Error: invalid namespace", isError: true };
    }

    const validBases = STRADA_API.baseClasses.systems;
    if (!validBases.includes(baseClass)) {
      return {
        content: `Error: base_class must be one of: ${validBases.join(", ")}`,
        isError: true,
      };
    }

    if (burstComponentCount !== undefined) {
      if (!Number.isInteger(burstComponentCount) || burstComponentCount < 1 || burstComponentCount > 4) {
        return {
          content: "Error: burst_component_count must be an integer between 1 and 4",
          isError: true,
        };
      }
      if (queryComponents.length !== burstComponentCount) {
        return {
          content: `Error: query_components must have exactly ${burstComponentCount} component(s) to match burst_component_count`,
          isError: true,
        };
      }
    }
    if (baseClass === "JobSystemBase" && queryComponents.length > 4) {
      return {
        content: "Error: JobSystemBase scaffolding supports up to 4 query_components",
        isError: true,
      };
    }

    for (const comp of queryComponents) {
      if (!isValidCSharpIdentifier(comp)) {
        return { content: `Error: invalid component name '${comp}'`, isError: true };
      }
    }
    for (const svc of injectServices) {
      if (!isValidCSharpIdentifier(svc)) {
        return { content: `Error: invalid service name '${svc}'`, isError: true };
      }
    }

    for (const sys of runBefore) {
      if (!isValidCSharpIdentifier(sys)) {
        return { content: `Error: invalid system name in run_before '${sys}'`, isError: true };
      }
    }
    for (const sys of runAfter) {
      if (!isValidCSharpIdentifier(sys)) {
        return { content: `Error: invalid system name in run_after '${sys}'`, isError: true };
      }
    }
    for (const sys of requiresSystem) {
      if (!isValidCSharpIdentifier(sys)) {
        return { content: `Error: invalid system name in requires_system '${sys}'`, isError: true };
      }
    }

    // Validate path
    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    const code = generateSystemCode({
      name, namespace, baseClass, queryComponents, injectServices,
      burstComponentCount, systemOrder, updatePhase, runBefore, runAfter, requiresSystem,
    });

    try {
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFile(pathCheck.fullPath, code, "utf-8");

      const effectiveBase = burstComponentCount
        ? `BurstSystem<${name}Job, ${queryComponents.join(", ")}>`
        : baseClass;
      const lines = [
        `System '${name}' created at: ${relPath}`,
        `  Base: ${effectiveBase}`,
      ];
      if (queryComponents.length > 0) {
        lines.push(`  Query: <${queryComponents.join(", ")}>`);
      }
      if (injectServices.length > 0) {
        lines.push(`  Injected: ${injectServices.join(", ")}`);
      }
      lines.push(
        "",
        `Next: Register in your ModuleConfig.`
      );

      return { content: lines.join("\n") };
    } catch {
      return { content: "Error: could not create system", isError: true };
    }
  }
}

interface SystemCodeOptions {
  name: string;
  namespace: string;
  baseClass: string;
  queryComponents: string[];
  injectServices: string[];
  burstComponentCount?: number;
  systemOrder: number;
  updatePhase: string;
  runBefore: string[];
  runAfter: string[];
  requiresSystem: string[];
}

function generateSystemCode(opts: SystemCodeOptions): string {
  const {
    name,
    namespace,
    baseClass,
    queryComponents,
    injectServices,
    burstComponentCount,
    systemOrder,
    updatePhase,
    runBefore,
    runAfter,
    requiresSystem,
  } = opts;
  const isBurstSystem = burstComponentCount !== undefined && burstComponentCount >= 1 && burstComponentCount <= 4;
  const isJobSystem = baseClass === "JobSystemBase";

  const usingSet = new Set([
    `using ${STRADA_API.namespaces.ecs};`,
    `using ${STRADA_API.namespaces.systems};`,
    `using ${STRADA_API.namespaces.modules};`,
  ]);

  if (isJobSystem || isBurstSystem) {
    usingSet.add(`using ${STRADA_API.namespaces.jobs};`);
    usingSet.add("using Unity.Burst;");
    usingSet.add("using Unity.Jobs;");
  }
  if (updatePhase) {
    usingSet.add(`using ${STRADA_API.namespaces.world};`);
  }

  // [Inject] field injection
  const hasInjection = injectServices.length > 0;
  if (hasInjection) {
    usingSet.add(`using ${STRADA_API.namespaces.diAttributes};`);
  }
  const usings = [...usingSet];

  const fields = injectServices
    .map((svc) => {
      const stripped = svc.replace(/^I/, "");
      const fieldName = stripped.charAt(0).toLowerCase() + stripped.slice(1);
      return `        [Inject] private readonly ${svc} _${fieldName};`;
    })
    .join("\n");

  const attributes: string[] = [];
  attributes.push("[StradaSystem]");
  attributes.push(`[ExecutionOrder(${systemOrder})]`);
  if (updatePhase) {
    attributes.push(`[UpdatePhase(UpdatePhase.${updatePhase})]`);
  }
  for (const sys of runBefore) {
    attributes.push(`[RunBefore(typeof(${sys}))]`);
  }
  for (const sys of runAfter) {
    attributes.push(`[RunAfter(typeof(${sys}))]`);
  }
  for (const sys of requiresSystem) {
    attributes.push(`[RequiresSystem(typeof(${sys}))]`);
  }

  if (isBurstSystem) {
    return generateBurstSystemCode({
      name,
      namespace,
      usings,
      attributes,
      fields,
      queryComponents,
    });
  }

  if (isJobSystem) {
    return generateJobSystemCode({
      name,
      namespace,
      usings,
      attributes,
      fields,
      queryComponents,
    });
  }

  // Query body using ForEach pattern
  let queryBody: string;
  if (queryComponents.length > 0) {
    const typeArgs = queryComponents.join(", ");
    const lambdaParams = queryComponents
      .map((c) => `ref ${c} ${c.charAt(0).toLowerCase() + c.slice(1)}`)
      .join(", ");
    queryBody = `            ForEach<${typeArgs}>((int entity, ${lambdaParams}) =>
            {
                // TODO: Process entity
            });`;
  } else {
    queryBody = `            // TODO: Implement system logic
            // ForEach<ComponentA, ComponentB>((int entity, ref ComponentA a, ref ComponentB b) =>
            // {
            //     // Process entity
            // });`;
  }

  return `${usings.join("\n")}

namespace ${namespace}
{
${attributes.map(a => `    ${a}`).join("\n")}
    public class ${name} : ${baseClass}
    {
${fields ? fields + "\n" : ""}
        protected override void OnInitialize() { }

        protected override void OnUpdate(float deltaTime)
        {
${queryBody}
        }

        protected override void OnDispose() { }
    }
}
`;
}

interface BurstSystemCodeOptions {
  name: string;
  namespace: string;
  usings: string[];
  attributes: string[];
  fields: string;
  queryComponents: string[];
}

function generateBurstSystemCode(opts: BurstSystemCodeOptions): string {
  const { name, namespace, usings, attributes, fields, queryComponents } = opts;
  const jobName = `${name}Job`;
  const typeArgs = queryComponents.join(", ");
  const baseType = `BurstSystem<${jobName}, ${typeArgs}>`;
  const jobInterface = `IJobComponent<${typeArgs}>`;
  const executeSignature = buildJobExecuteSignature(queryComponents);

  return `${usings.join("\n")}

namespace ${namespace}
{
    [BurstCompile]
    public struct ${jobName} : ${jobInterface}
    {
        public float DeltaTime;

        public void Execute(${executeSignature})
        {
            // TODO: Process components
        }
    }

${attributes.map(a => `    ${a}`).join("\n")}
    public class ${name} : ${baseType}
    {
${fields ? fields + "\n" : ""}
        protected override ${jobName} CreateJob(float deltaTime)
        {
            return new ${jobName}
            {
                DeltaTime = deltaTime,
            };
        }
    }
}
`;
}

interface JobSystemCodeOptions {
  name: string;
  namespace: string;
  usings: string[];
  attributes: string[];
  fields: string;
  queryComponents: string[];
}

function generateJobSystemCode(opts: JobSystemCodeOptions): string {
  const { name, namespace, usings, attributes, fields, queryComponents } = opts;
  const hasGeneratedJob = queryComponents.length > 0;
  const jobName = `${name}Job`;
  const typeArgs = queryComponents.join(", ");
  const jobStruct = hasGeneratedJob
    ? `
    [BurstCompile]
    public struct ${jobName} : IJobComponent<${typeArgs}>
    {
        public float DeltaTime;

        public void Execute(${buildJobExecuteSignature(queryComponents)})
        {
            // TODO: Process components
        }
    }
`
    : "";

  const scheduleCall = hasGeneratedJob
    ? `            return ScheduleParallel<${jobName}, ${typeArgs}>(
                new ${jobName}
                {
                    DeltaTime = deltaTime,
                },
                dependency: dependency);`
    : `            // TODO: Schedule one or more jobs.
            return dependency;`;

  return `${usings.join("\n")}

namespace ${namespace}
{
${jobStruct}${attributes.map((a) => `    ${a}`).join("\n")}
    public class ${name} : JobSystemBase
    {
${fields ? fields + "\n" : ""}
        protected override void OnCreate() { }

        protected override JobHandle OnSchedule(float deltaTime, JobHandle dependency)
        {
${scheduleCall}
        }

        protected override void OnDestroy() { }
    }
}
`;
}

function buildJobExecuteSignature(queryComponents: string[]): string {
  return [
    "int entity",
    ...queryComponents.map(
      (component) => `ref ${component} ${component.charAt(0).toLowerCase() + component.slice(1)}`,
    ),
  ].join(", ");
}
