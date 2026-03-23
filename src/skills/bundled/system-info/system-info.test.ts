import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:os and execFileNoThrow before importing the module under test
// ---------------------------------------------------------------------------

const mockUptime = vi.fn();
const mockLoadavg = vi.fn();
const mockCpus = vi.fn();
const mockTotalmem = vi.fn();
const mockFreemem = vi.fn();
const mockNetworkInterfaces = vi.fn();

vi.mock("node:os", () => ({
  default: {
    uptime: (...args: unknown[]) => mockUptime(...args),
    loadavg: (...args: unknown[]) => mockLoadavg(...args),
    cpus: (...args: unknown[]) => mockCpus(...args),
    totalmem: (...args: unknown[]) => mockTotalmem(...args),
    freemem: (...args: unknown[]) => mockFreemem(...args),
    networkInterfaces: (...args: unknown[]) => mockNetworkInterfaces(...args),
  },
}));

const mockExecFileNoThrow = vi.fn();

vi.mock("../../../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

// Must import *after* vi.mock so the mock is in place.
const { tools } = await import("./index.js");

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

beforeEach(() => {
  mockUptime.mockReset();
  mockLoadavg.mockReset();
  mockCpus.mockReset();
  mockTotalmem.mockReset();
  mockFreemem.mockReset();
  mockNetworkInterfaces.mockReset();
  mockExecFileNoThrow.mockReset();
});

// ---------------------------------------------------------------------------
// system_uptime
// ---------------------------------------------------------------------------

describe("system_uptime", () => {
  const tool = findTool("system_uptime");

  it("returns formatted uptime and load averages", async () => {
    // 2 days, 2 hours, 55 minutes, 42 seconds = 183342s
    mockUptime.mockReturnValue(183342);
    mockLoadavg.mockReturnValue([1.5, 2.0, 1.8]);

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("2d 2h 55m 42s");
    expect(result.content).toContain("1.50 / 2.00 / 1.80");
  });

  it("formats short uptime without days/hours", async () => {
    // 5 minutes 10 seconds = 310s
    mockUptime.mockReturnValue(310);
    mockLoadavg.mockReturnValue([0.1, 0.2, 0.3]);

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("5m 10s");
    // Uptime line should not contain days or hours markers
    const uptimeLine = result.content.split("\n")[0] ?? "";
    expect(uptimeLine).not.toContain("d ");
    expect(uptimeLine).not.toContain("h ");
  });

  it("formats zero uptime as just seconds", async () => {
    mockUptime.mockReturnValue(0);
    mockLoadavg.mockReturnValue([0, 0, 0]);

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("0s");
  });
});

// ---------------------------------------------------------------------------
// system_resources
// ---------------------------------------------------------------------------

describe("system_resources", () => {
  const tool = findTool("system_resources");

  it("returns CPU, memory, and disk info", async () => {
    mockCpus.mockReturnValue([
      { model: "Apple M1 Pro" },
      { model: "Apple M1 Pro" },
      { model: "Apple M1 Pro" },
      { model: "Apple M1 Pro" },
    ]);
    mockTotalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    mockFreemem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8 GB
    mockExecFileNoThrow.mockResolvedValue({
      exitCode: 0,
      stdout: "Filesystem     Size   Used  Avail Capacity  Mounted on\n/dev/disk1s1  466Gi  200Gi  250Gi    45%    /\n",
      stderr: "",
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Apple M1 Pro");
    expect(result.content).toContain("4 cores");
    expect(result.content).toContain("16.00 GB total");
    expect(result.content).toContain("8.00 GB free");
    expect(result.content).toContain("8.00 GB used");
    expect(result.content).toContain("Disk:");
    expect(result.content).toContain("/dev/disk1s1");
  });

  it("shows disk as unavailable when df fails", async () => {
    mockCpus.mockReturnValue([{ model: "Intel i7" }]);
    mockTotalmem.mockReturnValue(32 * 1024 * 1024 * 1024);
    mockFreemem.mockReturnValue(16 * 1024 * 1024 * 1024);
    mockExecFileNoThrow.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "df: error",
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Intel i7");
    expect(result.content).toContain("1 cores");
    expect(result.content).toContain("Disk: unavailable");
  });

  it("handles unknown CPU model gracefully", async () => {
    mockCpus.mockReturnValue([]);
    mockTotalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockFreemem.mockReturnValue(1 * 1024 * 1024 * 1024);
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "Filesystem\n/dev/sda1\n", stderr: "" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Unknown");
    expect(result.content).toContain("0 cores");
  });
});

// ---------------------------------------------------------------------------
// system_network
// ---------------------------------------------------------------------------

describe("system_network", () => {
  const tool = findTool("system_network");

  it("returns external network interfaces", async () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: [
        { family: "IPv4", address: "192.168.1.100", internal: false },
        { family: "IPv6", address: "fe80::1", internal: false },
      ],
      lo0: [
        { family: "IPv4", address: "127.0.0.1", internal: true },
      ],
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("en0: IPv4 192.168.1.100");
    expect(result.content).toContain("en0: IPv6 fe80::1");
    expect(result.content).not.toContain("127.0.0.1");
    expect(result.content).not.toContain("lo0");
  });

  it("returns message when no external interfaces found", async () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [
        { family: "IPv4", address: "127.0.0.1", internal: true },
      ],
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("No external network interfaces found");
  });

  it("handles empty network interfaces", async () => {
    mockNetworkInterfaces.mockReturnValue({});

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("No external network interfaces found");
  });

  it("handles null interface values gracefully", async () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: null,
      en1: [
        { family: "IPv4", address: "10.0.0.5", internal: false },
      ],
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("en1: IPv4 10.0.0.5");
    expect(result.content).not.toContain("en0");
  });
});
