import { requestUrl } from "obsidian";
import type {
  AnythingLLMDocument,
  AnythingLLMSyncSettings,
  UploadDocumentResult,
  WorkspaceOption,
} from "../types";
import { normalizeBaseUrl } from "../utils/path";

interface WorkspaceApiResponse {
  workspaces?: Array<{ name?: string; slug?: string }>;
}

export class AnythingLLMClient {
  constructor(private readonly getSettings: () => AnythingLLMSyncSettings) {}

  async testConnection(): Promise<void> {
    const response = await requestUrl({
      url: `${this.apiBase()}/v1/auth`,
      method: "GET",
      headers: this.authHeaders(),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`AnythingLLM connection failed (HTTP ${response.status}).`);
    }
  }

  async listWorkspaces(): Promise<WorkspaceOption[]> {
    this.validateConnectionSettings();

    const response = await requestUrl({
      url: `${this.apiBase()}/v1/workspaces`,
      method: "GET",
      headers: this.authHeaders(),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(this.responseError(response.status, response.text, response.json));
    }

    const payload = response.json as WorkspaceApiResponse;
    return (payload.workspaces ?? [])
      .filter((workspace): workspace is { name: string; slug: string } =>
        Boolean(workspace.name && workspace.slug),
      )
      .map((workspace) => ({ name: workspace.name, slug: workspace.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async uploadMarkdown(params: {
    filename: string;
    content: string;
    workspaceSlug: string;
  }): Promise<AnythingLLMDocument> {
    this.validateConnectionSettings();
    if (!params.workspaceSlug.trim()) throw new Error("AnythingLLM workspace is not selected.");

    const boundary = `----obsidian-anythingllm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = this.buildUploadBody(boundary, params);

    const response = await requestUrl({
      url: `${this.apiBase()}/v1/document/upload`,
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(this.responseError(response.status, response.text, response.json));
    }

    const payload = response.json as UploadDocumentResult;
    if (payload.success === false) {
      throw new Error(payload.error || "AnythingLLM rejected the document upload.");
    }

    const document = payload.documents?.[0];
    if (!document?.location) {
      throw new Error("AnythingLLM upload succeeded but returned no document location.");
    }

    return document;
  }

  private validateConnectionSettings(): void {
    const settings = this.getSettings();
    if (!settings.baseUrl.trim()) throw new Error("AnythingLLM URL is not configured.");
    if (!settings.apiKey.trim()) throw new Error("AnythingLLM Developer API key is not configured.");
  }

  private apiBase(): string {
    const base = normalizeBaseUrl(this.getSettings().baseUrl);
    return base.endsWith("/api") ? base : `${base}/api`;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getSettings().apiKey.trim()}`,
      Accept: "application/json",
    };
  }

  private buildUploadBody(
    boundary: string,
    params: { filename: string; content: string; workspaceSlug: string },
  ): ArrayBuffer {
    const encoder = new TextEncoder();
    const safeFilename = params.filename.replace(/["\r\n]/g, "_");
    const chunks = [
      encoder.encode(`--${boundary}\r\n`),
      encoder.encode(
        `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
          "Content-Type: text/markdown; charset=utf-8\r\n\r\n",
      ),
      encoder.encode(params.content),
      encoder.encode("\r\n"),
      encoder.encode(`--${boundary}\r\n`),
      encoder.encode('Content-Disposition: form-data; name="addToWorkspaces"\r\n\r\n'),
      encoder.encode(params.workspaceSlug.trim()),
      encoder.encode("\r\n"),
      encoder.encode(`--${boundary}--\r\n`),
    ];

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  }

  private responseError(status: number, text: string, json: unknown): string {
    let detail = "";
    if (json && typeof json === "object" && "error" in json) {
      const error = (json as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) detail = error.trim();
    }
    if (!detail && text?.trim()) detail = text.trim().slice(0, 400);
    return `AnythingLLM API request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`;
  }
}
