/**
 * A copy of Strada.Core's ModuleSourceTemplates.cs (Core c011e7f), for tests
 * that need a project whose framework declares its module templates.
 *
 * A copy rots. `module-templates.test.ts` renders it beside the Strada.Core
 * checked out next to this repo (or at STRADA_CORE_PATH) for many selections and
 * fails when the two disagree; refresh this file from the checkout then.
 */

export const CORE_TEMPLATES_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Text;

namespace Strada.Core.Editor.ModuleGenerator.Templates
{
    /// <summary>
    /// Which parts of a module are generated, and therefore which types the other generated
    /// files may refer to. A plain struct with no Unity dependency so the templates can be
    /// compiled and checked outside the editor.
    /// </summary>
    public readonly struct ModuleTemplateOptions
    {
        public readonly bool ModuleConfig;
        public readonly bool ServiceInterface;
        public readonly bool Service;
        public readonly bool Controller;
        public readonly bool Model;
        public readonly bool View;
        public readonly bool EcsSystem;
        public readonly bool EcsComponent;
        public readonly bool EntityMediator;
        public readonly bool ConfigData;
        public readonly bool ValueObject;
        public readonly bool Events;
        public readonly bool Signals;
        public readonly bool RuntimeTests;
        public readonly bool EditorTests;
        /// <summary>Emit XML summaries on generated types (the generator's GenerateSummaries setting).</summary>
        public readonly bool Summaries;

        public ModuleTemplateOptions(
            bool moduleConfig = false, bool serviceInterface = false, bool service = false, bool controller = false,
            bool model = false, bool view = false, bool ecsSystem = false, bool ecsComponent = false,
            bool entityMediator = false, bool configData = false, bool valueObject = false, bool events = false,
            bool signals = false, bool runtimeTests = false, bool editorTests = false, bool summaries = true)
        {
            ModuleConfig = moduleConfig;
            ServiceInterface = serviceInterface;
            Service = service;
            Controller = controller;
            Model = model;
            View = view;
            EcsSystem = ecsSystem;
            EcsComponent = ecsComponent;
            EntityMediator = entityMediator;
            ConfigData = configData;
            ValueObject = valueObject;
            Events = events;
            Signals = signals;
            RuntimeTests = runtimeTests;
            EditorTests = editorTests;
            Summaries = summaries;
        }

        /// <summary>The service type a controller or module config refers to, or null when no service is generated.</summary>
        public string ServiceTypeName(string name) =>
            !Service ? null : ServiceInterface ? $"I{name}Service" : $"{name}Service";
    }

    /// <summary>
    /// One generated file: which component it belongs to (that decides its folder), its
    /// file name, its default path relative to the module root, and its source.
    /// </summary>
    public readonly struct GeneratedFile
    {
        public readonly Config.ComponentType Component;
        public readonly string FileName;
        /// <summary>Folder from the default <see cref="Config.ModuleLayout"/> plus the file name.</summary>
        public readonly string RelativePath;
        public readonly string Source;

        public GeneratedFile(Config.ComponentType component, string fileName, string source)
        {
            Component = component;
            FileName = fileName;
            RelativePath = Config.ModuleLayout.FolderFor(component) + "/" + fileName;
            Source = source;
        }
    }

    /// <summary>
    /// The source text of every file the module generator can write. Pure string building:
    /// no Unity, no file system, so the same code that generation and the preview run is
    /// also compiled against the real framework in the Unity-free test project, for every
    /// supported selection.
    ///
    /// Each generated file refers only to types that the SAME selection generates or that
    /// the framework provides. The module config used to register I{Name}Service,
    /// {Name}Service and {Name}Controller unconditionally, so switching any of them off
    /// produced a module that did not compile (ED-02); the controller and service were
    /// plain classes with [Inject] fields and Initialize/Tick methods that nothing ever
    /// injected, initialized or ticked (ED-03).
    /// </summary>
    public static class ModuleSourceTemplates
    {
        /// <summary>Every file the selection produces, in generation order.</summary>
        public static List<GeneratedFile> Files(string name, string ns, ModuleTemplateOptions o)
        {
            // The folder of each file comes from ModuleLayout through the component it
            // belongs to, so the config, the folder step, this list and the preview cannot
            // disagree about where a file goes (CFG-03).
            var files = new List<GeneratedFile>(16);
            void Add(bool enabled, Config.ComponentType component, string fileName, Func<string> source)
            {
                if (enabled) files.Add(new GeneratedFile(component, fileName, source()));
            }

            Add(o.ModuleConfig, Config.ComponentType.ModuleConfig, $"{name}ModuleConfig.cs", () => ModuleConfig(name, ns, o));
            Add(o.ServiceInterface, Config.ComponentType.ServiceInterface, $"I{name}Service.cs", () => ServiceInterface(name, ns, o));
            Add(o.Service, Config.ComponentType.Service, $"{name}Service.cs", () => Service(name, ns, o));
            Add(o.Controller, Config.ComponentType.Controller, $"{name}Controller.cs", () => Controller(name, ns, o));
            Add(o.Model, Config.ComponentType.Model, $"{name}Model.cs", () => Model(name, ns, o));
            Add(o.View, Config.ComponentType.View, $"{name}View.cs", () => View(name, ns, o));
            Add(o.EcsSystem, Config.ComponentType.EcsSystem, $"{name}System.cs", () => System(name, ns, o));
            Add(o.EcsComponent, Config.ComponentType.EcsComponent, $"{name}Component.cs", () => Component(name, ns, o));
            Add(o.EntityMediator, Config.ComponentType.EntityMediator, $"{name}Mediator.cs", () => Mediator(name, ns, o));
            Add(o.ConfigData, Config.ComponentType.ConfigData, $"CD_{name}.cs", () => ConfigData(name, ns, o));
            Add(o.ValueObject, Config.ComponentType.ValueObject, $"{name}Config.cs", () => ValueObject(name, ns, o));
            Add(o.Events, Config.ComponentType.Events, $"{name}Events.cs", () => Events(name, ns, o));
            Add(o.Signals, Config.ComponentType.Signals, $"{name}Signals.cs", () => Signals(name, ns, o));
            Add(o.RuntimeTests, Config.ComponentType.RuntimeTests, $"{name}Tests.cs", () => RuntimeTests(name, ns));
            Add(o.EditorTests, Config.ComponentType.EditorTests, $"{name}EditorTests.cs", () => EditorTests(name, ns));
            return files;
        }

        public static string ModuleConfig(string name, string ns, ModuleTemplateOptions o)
        {
            var usings = new List<string> { "using UnityEngine;", "using Strada.Core.DI;", "using Strada.Core.Modules;" };
            var serviceType = o.ServiceTypeName(name);
            var registersPatterns = serviceType != null || o.Controller;
            if (registersPatterns) usings.Add("using Strada.Core.Patterns;");

            return Wrap(ns, usings.ToArray(), sb =>
            {
                Summary(sb, $"Module configuration for {name}.", 1, o);
                sb.AppendLine($"    [CreateAssetMenu(fileName = \"{name}ModuleConfig\", menuName = \"{name}/Module Config\")]");
                sb.AppendLine($"    public class {name}ModuleConfig : ModuleConfig");
                sb.AppendLine("    {");
                sb.AppendLine("        protected override void Configure(IModuleBuilder builder)");
                sb.AppendLine("        {");
                if (serviceType != null)
                {
                    sb.AppendLine(o.ServiceInterface
                        ? $"            builder.RegisterService<I{name}Service, {name}Service>();"
                        : $"            builder.RegisterService<{name}Service>();");
                }
                if (o.Controller)
                    sb.AppendLine($"            builder.RegisterController<{name}Controller>();");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        /// <summary>");
                sb.AppendLine("        /// Hands the module's controllers and services to the bootstrapper's PatternManager,");
                sb.AppendLine("        /// which initializes them after every module is installed, ticks them each frame and");
                sb.AppendLine("        /// disposes them at shutdown.");
                sb.AppendLine("        /// </summary>");
                sb.AppendLine("        public override void Initialize(IServiceLocator services)");
                sb.AppendLine("        {");
                if (registersPatterns)
                {
                    sb.AppendLine("            var patterns = services.Get<PatternManager>();");
                    if (serviceType != null)
                        sb.AppendLine($"            patterns.RegisterService(services.Get<{serviceType}>());");
                    if (o.Controller)
                        sb.AppendLine($"            patterns.RegisterController(services.Get<{name}Controller>());");
                }
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        public override void Shutdown()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string ServiceInterface(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using Strada.Core.Patterns.Interfaces;" }, sb =>
            {
                Summary(sb, $"Service interface for {name} functionality.", 1, o);
                sb.AppendLine($"    public interface I{name}Service : IService");
                sb.AppendLine("    {");
                sb.AppendLine("    }");
            });
        }

        public static string Service(string name, string ns, ModuleTemplateOptions o)
        {
            var baseList = o.ServiceInterface ? $"Service, I{name}Service" : "Service";
            return Wrap(ns, new[] { "using Strada.Core.Patterns;" }, sb =>
            {
                Summary(sb, $"Service implementation for {name}.", 1, o);
                sb.AppendLine($"    public class {name}Service : {baseList}");
                sb.AppendLine("    {");
                sb.AppendLine("        /// <summary>Called once, after every module is installed. EventBus, World and Container are available.</summary>");
                sb.AppendLine("        protected override void OnInitialize()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnDispose()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string Controller(string name, string ns, ModuleTemplateOptions o)
        {
            var serviceType = o.ServiceTypeName(name);
            var usings = new List<string> { "using Strada.Core.Patterns;" };
            if (serviceType != null) usings.Insert(0, "using Strada.Core.DI.Attributes;");

            return Wrap(ns, usings.ToArray(), sb =>
            {
                Summary(sb, $"Controller for {name} functionality.", 1, o);
                sb.AppendLine($"    public class {name}Controller : TickableController");
                sb.AppendLine("    {");
                if (serviceType != null)
                {
                    sb.AppendLine($"        [Inject] private {serviceType} _service;");
                    sb.AppendLine();
                }
                sb.AppendLine("        /// <summary>Called once, after every module is installed. EventBus, World and Container are available.</summary>");
                sb.AppendLine("        protected override void OnInitialize()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        public override void Tick(float deltaTime)");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnDispose()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string Model(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using Strada.Core.Sync;" }, sb =>
            {
                Summary(sb, $"Model for {name} state management.", 1, o);
                sb.AppendLine($"    public class {name}Model");
                sb.AppendLine("    {");
                sb.AppendLine("        public ReactiveProperty<int> Value { get; } = new(0);");
                sb.AppendLine();
                sb.AppendLine("        public void Reset()");
                sb.AppendLine("        {");
                sb.AppendLine("            Value.Value = 0;");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string View(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using UnityEngine;", "using Strada.Core.Patterns;" }, sb =>
            {
                Summary(sb, $"View for {name} visual representation.", 1, o);
                sb.AppendLine($"    public class {name}View : View");
                sb.AppendLine("    {");
                sb.AppendLine("        public override void Initialize()");
                sb.AppendLine("        {");
                sb.AppendLine("            base.Initialize();");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnShow()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnHide()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string System(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using Strada.Core.ECS;", "using Strada.Core.ECS.Systems;" }, sb =>
            {
                Summary(sb, $"ECS System for {name} processing.", 1, o);
                sb.AppendLine("    [SystemOrder(0)]");
                sb.AppendLine($"    public class {name}System : SystemBase");
                sb.AppendLine("    {");
                sb.AppendLine("        protected override void OnInitialize()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnUpdate(float deltaTime)");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnDispose()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string Component(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using System.Runtime.InteropServices;", "using Strada.Core.ECS;" }, sb =>
            {
                Summary(sb, $"ECS Component for {name} data.", 1, o);
                sb.AppendLine("    [StructLayout(LayoutKind.Sequential)]");
                sb.AppendLine($"    public struct {name}Component : IComponent");
                sb.AppendLine("    {");
                sb.AppendLine("        public float Value;");
                sb.AppendLine("    }");
            });
        }

        public static string Mediator(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using Strada.Core.Sync;" }, sb =>
            {
                Summary(sb, $"Entity mediator for {name} view binding.", 1, o);
                sb.AppendLine($"    public class {name}Mediator : EntityMediator<{name}View>");
                sb.AppendLine("    {");
                sb.AppendLine("        protected override void OnBind()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        protected override void OnUnbind()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string ConfigData(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using UnityEngine;", "using Strada.Core.Data;" }, sb =>
            {
                Summary(sb, $"Configuration data for {name}.", 1, o);
                sb.AppendLine($"    [CreateAssetMenu(fileName = \"CD_{name}\", menuName = \"{name}/Config/{name}\")]");
                sb.AppendLine($"    public class CD_{name} : ConfigData<{name}Config>");
                sb.AppendLine("    {");
                sb.AppendLine("    }");
            });
        }

        public static string ValueObject(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using System;", "using UnityEngine;" }, sb =>
            {
                Summary(sb, $"Value object for {name} configuration.", 1, o);
                sb.AppendLine("    [Serializable]");
                sb.AppendLine($"    public class {name}Config");
                sb.AppendLine("    {");
                sb.AppendLine("        [SerializeField] private string _id;");
                sb.AppendLine("        [SerializeField] private int _value;");
                sb.AppendLine();
                sb.AppendLine("        public string Id => _id;");
                sb.AppendLine("        public int Value => _value;");
                sb.AppendLine("    }");
            });
        }

        public static string Events(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, Array.Empty<string>(), sb =>
            {
                Summary(sb, $"Events for {name} state changes.", 1, o);
                sb.AppendLine($"    public readonly struct {name}ChangedEvent");
                sb.AppendLine("    {");
                sb.AppendLine("        public readonly int Value;");
                sb.AppendLine();
                sb.AppendLine($"        public {name}ChangedEvent(int value)");
                sb.AppendLine("        {");
                sb.AppendLine("            Value = value;");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string Signals(string name, string ns, ModuleTemplateOptions o)
        {
            return Wrap(ns, new[] { "using Strada.Core.ECS;" }, sb =>
            {
                Summary(sb, $"Signals for {name} actions.", 1, o);
                sb.AppendLine($"    public struct {name}Signal");
                sb.AppendLine("    {");
                sb.AppendLine("        public Entity Entity;");
                sb.AppendLine("    }");
            });
        }

        public static string RuntimeTests(string name, string ns)
        {
            return Wrap($"{ns}.Tests", new[] { "using NUnit.Framework;" }, sb =>
            {
                sb.AppendLine("    [TestFixture]");
                sb.AppendLine($"    public class {name}Tests");
                sb.AppendLine("    {");
                sb.AppendLine("        [SetUp]");
                sb.AppendLine("        public void SetUp()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        [TearDown]");
                sb.AppendLine("        public void TearDown()");
                sb.AppendLine("        {");
                sb.AppendLine("        }");
                sb.AppendLine();
                sb.AppendLine("        [Test]");
                sb.AppendLine("        public void Example_Test()");
                sb.AppendLine("        {");
                sb.AppendLine("            Assert.Pass();");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        public static string EditorTests(string name, string ns)
        {
            return Wrap($"{ns}.Tests", new[] { "using NUnit.Framework;", "using UnityEditor;" }, sb =>
            {
                sb.AppendLine("    [TestFixture]");
                sb.AppendLine($"    public class {name}EditorTests");
                sb.AppendLine("    {");
                sb.AppendLine("        [Test]");
                sb.AppendLine("        public void Editor_Test()");
                sb.AppendLine("        {");
                sb.AppendLine("            Assert.Pass();");
                sb.AppendLine("        }");
                sb.AppendLine("    }");
            });
        }

        private static string Wrap(string ns, string[] usings, Action<StringBuilder> writeBody)
        {
            var sb = new StringBuilder();
            foreach (var u in usings)
                sb.AppendLine(u);
            if (usings.Length > 0)
                sb.AppendLine();
            sb.AppendLine($"namespace {ns}");
            sb.AppendLine("{");
            writeBody(sb);
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static void Summary(StringBuilder sb, string summary, int indent, ModuleTemplateOptions o)
        {
            if (!o.Summaries) return;
            var padding = new string(' ', indent * 4);
            sb.AppendLine($"{padding}/// <summary>");
            sb.AppendLine($"{padding}/// {summary}");
            sb.AppendLine($"{padding}/// </summary>");
        }
    }
}
`;
