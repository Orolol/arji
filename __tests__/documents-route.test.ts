import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
  insertedValues: [] as unknown[],
}));

const mockConvertToMarkdown = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
    all: vi.fn(() => mockDbState.allQueue.shift() ?? []),
    insert: vi.fn().mockReturnValue({
      values: vi.fn((payload: unknown) => {
        mockDbState.insertedValues.push(payload);
        return { run: vi.fn() };
      }),
    }),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  documents: {
    id: "id",
    projectId: "projectId",
    originalFilename: "originalFilename",
    createdAt: "createdAt",
  },
}));

vi.mock("@/lib/converters", () => ({
  convertToMarkdown: mockConvertToMarkdown,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "doc-1"),
}));

vi.mock("fs", () => ({
  default: {
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  },
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

type MockUploadFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

function createMockFile(content: string | Uint8Array, name: string, type: string): MockUploadFile {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );

  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => buffer,
  };
}

function makeRequest(file: MockUploadFile) {
  return {
    formData: async () => ({
      get: (key: string) => (key === "file" ? file : null),
    }),
  } as unknown as import("next/server").NextRequest;
}

describe("Documents route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockDbState.allQueue = [];
    mockDbState.insertedValues = [];
    mockConvertToMarkdown.mockResolvedValue("# Converted markdown");
  });

  it("stores text uploads as markdown in DB", async () => {
    mockDbState.getQueue = [
      null,
      {
        id: "doc-1",
        projectId: "proj-1",
        originalFilename: "spec.md",
        kind: "text",
        markdownContent: "# Converted markdown",
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/documents/route");
    const file = createMockFile("hello", "spec.md", "text/markdown");

    const res = await POST(makeRequest(file), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(mockConvertToMarkdown).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    expect(mockDbState.insertedValues[0]).toMatchObject({
      projectId: "proj-1",
      originalFilename: "spec.md",
      kind: "text",
      markdownContent: "# Converted markdown",
      imagePath: null,
      mimeType: "text/markdown",
      sizeBytes: file.size,
    });
    expect(json.data.kind).toBe("text");
  });

  it("stores image uploads on disk and only persists metadata in DB", async () => {
    mockDbState.getQueue = [
      null,
      {
        id: "doc-1",
        projectId: "proj-1",
        originalFilename: "diagram.png",
        kind: "image",
        markdownContent: null,
        imagePath: "data/documents/proj-1/doc-1-diagram.png",
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/documents/route");
    const file = createMockFile(new Uint8Array([1, 2, 3]), "diagram.png", "image/png");

    const res = await POST(makeRequest(file), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(mockConvertToMarkdown).not.toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    expect(mockDbState.insertedValues[0]).toMatchObject({
      projectId: "proj-1",
      originalFilename: "diagram.png",
      kind: "image",
      markdownContent: null,
      imagePath: "data/documents/proj-1/doc-1-diagram.png",
      mimeType: "image/png",
      sizeBytes: file.size,
    });
    expect(json.data.kind).toBe("image");
  });

  it("rejects duplicate filenames case-insensitively within the same project", async () => {
    mockDbState.getQueue = [{ id: "existing-doc" }];

    const { POST } = await import("@/app/api/projects/[projectId]/documents/route");
    const file = createMockFile("hello", "Spec.MD", "text/markdown");

    const res = await POST(makeRequest(file), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain("already exists");
    expect(mockDbState.insertedValues).toHaveLength(0);
  });

  it("allows the same filename in different projects", async () => {
    mockDbState.getQueue = [
      null,
      {
        id: "doc-1",
        projectId: "proj-2",
        originalFilename: "README.md",
        kind: "text",
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/documents/route");
    const file = createMockFile("hello", "README.md", "text/markdown");

    const res = await POST(makeRequest(file), {
      params: Promise.resolve({ projectId: "proj-2" }),
    });

    expect(res.status).toBe(201);
    expect(mockDbState.insertedValues[0]).toMatchObject({
      projectId: "proj-2",
      originalFilename: "README.md",
    });
  });

  it("lists project documents", async () => {
    mockDbState.allQueue = [
      [
        {
          id: "doc-1",
          projectId: "proj-1",
          originalFilename: "README.md",
          kind: "text",
        },
      ],
    ];

    const { GET } = await import("@/app/api/projects/[projectId]/documents/route");

    const res = await GET({} as import("next/server").NextRequest, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].originalFilename).toBe("README.md");
  });
});
