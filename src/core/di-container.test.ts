import { describe, it, expect, beforeEach } from "vitest";
import {
  DIContainer,
  ServiceNotFoundError,
  CircularDependencyError,
  getContainer,
  resetContainer,
  createContainer,
  Services,
} from "./di-container.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FakeLogger {
  log(msg: string): string {
    return msg;
  }
}

class FakeConfig {
  value = 42;
}

class CountingService {
  static instanceCount = 0;
  readonly id: number;
  constructor() {
    CountingService.instanceCount++;
    this.id = CountingService.instanceCount;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DIContainer", () => {
  let container: DIContainer;

  beforeEach(() => {
    container = new DIContainer();
    CountingService.instanceCount = 0;
  });

  // ========================================================================
  // Registration & Resolution — Transient
  // ========================================================================

  describe("registerTransient / resolve", () => {
    it("creates a new instance on every resolve", () => {
      container.registerTransient("Counter", CountingService);

      const a = container.resolve<CountingService>("Counter");
      const b = container.resolve<CountingService>("Counter");

      expect(a).toBeInstanceOf(CountingService);
      expect(b).toBeInstanceOf(CountingService);
      expect(a).not.toBe(b);
      expect(a.id).toBe(1);
      expect(b.id).toBe(2);
    });
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe("registerSingleton / resolve", () => {
    it("returns the same instance on every resolve", () => {
      container.registerSingleton("Counter", CountingService);

      const a = container.resolve<CountingService>("Counter");
      const b = container.resolve<CountingService>("Counter");

      expect(a).toBe(b);
      expect(CountingService.instanceCount).toBe(1);
    });
  });

  // ========================================================================
  // Singleton Factory
  // ========================================================================

  describe("registerSingletonFactory", () => {
    it("calls the factory only once and caches the result", () => {
      let calls = 0;
      container.registerSingletonFactory("FakeLogger", () => {
        calls++;
        return new FakeLogger();
      });

      const a = container.resolve<FakeLogger>("FakeLogger");
      const b = container.resolve<FakeLogger>("FakeLogger");

      expect(a).toBe(b);
      expect(calls).toBe(1);
      expect(a).toBeInstanceOf(FakeLogger);
    });
  });

  // ========================================================================
  // Instance Registration
  // ========================================================================

  describe("registerInstance", () => {
    it("returns the exact pre-built instance", () => {
      const logger = new FakeLogger();
      // registerInstance bypasses the registrations map, so we also need a registration
      // for resolve() to work. However, looking at the code, registerInstance only sets
      // singletons — resolve still requires a registration entry. Let's verify behavior:
      // If there's no registration, resolve throws. registerInstance is meant for
      // pre-populating singletons alongside a registration.

      container.registerSingleton("FakeLogger", FakeLogger);
      container.registerInstance("FakeLogger", logger);

      const resolved = container.resolve<FakeLogger>("FakeLogger");
      expect(resolved).toBe(logger);
    });
  });

  // ========================================================================
  // Missing Service
  // ========================================================================

  describe("missing service", () => {
    it("throws ServiceNotFoundError for unregistered service", () => {
      expect(() => container.resolve("Missing")).toThrow(ServiceNotFoundError);
      expect(() => container.resolve("Missing")).toThrow("Service not registered: Missing");
    });

    it("ServiceNotFoundError exposes the service name", () => {
      try {
        container.resolve("Phantom");
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceNotFoundError);
        expect((e as ServiceNotFoundError).serviceName).toBe("Phantom");
      }
    });
  });

  // ========================================================================
  // tryResolve
  // ========================================================================

  describe("tryResolve", () => {
    it("returns undefined for unregistered service", () => {
      expect(container.tryResolve("Nope")).toBeUndefined();
    });

    it("returns the instance for a registered service", () => {
      container.registerSingleton("FakeConfig", FakeConfig);
      const result = container.tryResolve<FakeConfig>("FakeConfig");
      expect(result).toBeInstanceOf(FakeConfig);
    });
  });

  // ========================================================================
  // isRegistered
  // ========================================================================

  describe("isRegistered", () => {
    it("returns true for registered services", () => {
      container.registerTransient("FakeLogger", FakeLogger);
      expect(container.isRegistered("FakeLogger")).toBe(true);
    });

    it("returns false for unregistered services", () => {
      expect(container.isRegistered("Unknown")).toBe(false);
    });
  });

  // ========================================================================
  // getRegisteredServices
  // ========================================================================

  describe("getRegisteredServices", () => {
    it("returns names of all registered services", () => {
      container.registerTransient("A", FakeLogger);
      container.registerSingleton("B", FakeConfig);

      const names = container.getRegisteredServices();
      expect(names).toContain("A");
      expect(names).toContain("B");
      expect(names).toHaveLength(2);
    });
  });

  // ========================================================================
  // clear
  // ========================================================================

  describe("clear", () => {
    it("removes all registrations and singletons", () => {
      container.registerSingleton("Logger", FakeLogger);
      container.resolve("Logger"); // populate singleton cache
      container.clear();

      expect(container.isRegistered("Logger")).toBe(false);
      expect(container.getRegisteredServices()).toEqual([]);
    });
  });

  // ========================================================================
  // Circular Dependency Detection
  // ========================================================================

  describe("circular dependency detection", () => {
    it("throws CircularDependencyError for self-referencing factory", () => {
      container.registerSingletonFactory("Self", () => {
        return container.resolve("Self");
      });

      expect(() => container.resolve("Self")).toThrow(CircularDependencyError);
    });

    it("CircularDependencyError exposes service name and chain in message", () => {
      container.registerSingletonFactory("A", () => container.resolve("B"));
      container.registerSingletonFactory("B", () => container.resolve("A"));

      try {
        container.resolve("A");
        // Should not reach here
        expect.unreachable("Expected CircularDependencyError");
      } catch (e) {
        expect(e).toBeInstanceOf(CircularDependencyError);
        const err = e as CircularDependencyError;
        // The inner-most circular ref is detected — serviceName is "A" (re-entered)
        expect(err.serviceName).toBe("A");
        // The message captures the chain before the finally block clears it
        expect(err.message).toContain("A");
        expect(err.message).toContain("B");
        expect(err.message).toContain("Circular dependency detected");
      }
    });

    it("resolution stack is cleaned up after error", () => {
      container.registerSingletonFactory("Loop", () => container.resolve("Loop"));

      expect(() => container.resolve("Loop")).toThrow(CircularDependencyError);

      // Registering a valid service afterward should work fine
      container.registerSingleton("Safe", FakeLogger);
      expect(container.resolve<FakeLogger>("Safe")).toBeInstanceOf(FakeLogger);
    });
  });

  // ========================================================================
  // Scoped Lifecycle
  // ========================================================================

  describe("registerScoped / createScope", () => {
    it("creates separate instances per scope", () => {
      container.registerScoped("Counter", CountingService);

      const scope1 = container.createScope();
      const scope2 = container.createScope();

      const a = scope1.resolve<CountingService>("Counter");
      const b = scope2.resolve<CountingService>("Counter");

      // Both are CountingService instances but from separate scopes
      expect(a).toBeInstanceOf(CountingService);
      expect(b).toBeInstanceOf(CountingService);
      // transient-like across scopes since scoped does not cache in this implementation
      expect(a).not.toBe(b);
    });

    it("child scope shares singleton instances from parent", () => {
      container.registerSingleton("Logger", FakeLogger);
      const parentInstance = container.resolve<FakeLogger>("Logger");

      const child = container.createScope();
      const childInstance = child.resolve<FakeLogger>("Logger");

      expect(childInstance).toBe(parentInstance);
    });

    it("child scope copies registrations from parent", () => {
      container.registerTransient("Config", FakeConfig);

      const child = container.createScope();
      expect(child.isRegistered("Config")).toBe(true);
      expect(child.resolve<FakeConfig>("Config")).toBeInstanceOf(FakeConfig);
    });
  });

  // ========================================================================
  // Fluent API (method chaining)
  // ========================================================================

  describe("fluent registration API", () => {
    it("registerTransient returns the container for chaining", () => {
      const result = container.registerTransient("A", FakeLogger);
      expect(result).toBe(container);
    });

    it("registerSingleton returns the container for chaining", () => {
      const result = container.registerSingleton("B", FakeConfig);
      expect(result).toBe(container);
    });

    it("registerSingletonFactory returns the container for chaining", () => {
      const result = container.registerSingletonFactory("C", () => new FakeLogger());
      expect(result).toBe(container);
    });

    it("registerScoped returns the container for chaining", () => {
      const result = container.registerScoped("D", FakeLogger);
      expect(result).toBe(container);
    });

    it("registerInstance returns the container for chaining", () => {
      const result = container.registerInstance("E", new FakeLogger());
      expect(result).toBe(container);
    });

    it("supports full chaining", () => {
      container
        .registerTransient("A", FakeLogger)
        .registerSingleton("B", FakeConfig)
        .registerSingletonFactory("C", () => new FakeLogger());

      expect(container.getRegisteredServices()).toHaveLength(3);
    });
  });

  // ========================================================================
  // Global Container Functions
  // ========================================================================

  describe("global container helpers", () => {
    beforeEach(() => {
      resetContainer();
    });

    it("getContainer returns a singleton global container", () => {
      const c1 = getContainer();
      const c2 = getContainer();
      expect(c1).toBe(c2);
      expect(c1).toBeInstanceOf(DIContainer);
    });

    it("resetContainer clears the global container", () => {
      const c1 = getContainer();
      resetContainer();
      const c2 = getContainer();
      expect(c1).not.toBe(c2);
    });

    it("createContainer returns a fresh container", () => {
      const c1 = createContainer();
      const c2 = createContainer();
      expect(c1).not.toBe(c2);
      expect(c1).toBeInstanceOf(DIContainer);
    });
  });

  // ========================================================================
  // Services constants
  // ========================================================================

  describe("Services constants", () => {
    it("contains expected service keys", () => {
      expect(Services.Logger).toBe("Logger");
      expect(Services.Config).toBe("Config");
      expect(Services.ToolRegistry).toBe("ToolRegistry");
      expect(Services.Orchestrator).toBe("Orchestrator");
    });
  });
});
