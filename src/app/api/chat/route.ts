import { NextRequest } from "next/server";

export const runtime = "edge"; // Use edge runtime for streaming

export async function POST(req: NextRequest) {
  try {
    const { query, model, rewrite_query, max_num_results, ranking_options } = await req.json();

    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const ragName = process.env.AUTORAG_NAME;
    const apiBaseUrl = process.env.CLOUDFLARE_API_BASE_URL;

    if (!apiToken || !accountId || !ragName || !apiBaseUrl) {
      return new Response(JSON.stringify({ error: "Missing API configuration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiUrl = `${apiBaseUrl}/accounts/${accountId}/autorag/rags/${ragName}/ai-search`;

    const requestBody = {
      query,
      stream: true, // Enable streaming from Cloudflare
      ...(model && { model }),
      ...(rewrite_query !== undefined && { rewrite_query }),
      ...(max_num_results && { max_num_results }),
      ...(ranking_options && { ranking_options }),
    };

    const cfResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!cfResponse.ok) {
      const errorText = await cfResponse.text();
      console.error("Cloudflare API Error:", errorText);
      return new Response(
        JSON.stringify({ error: `Cloudflare API error: ${cfResponse.statusText}`, details: errorText }),
        {
          status: cfResponse.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!cfResponse.body) {
      return new Response(JSON.stringify({ error: "No response body from Cloudflare API" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Proxy the stream directly
    return new Response(cfResponse.body, {
      status: cfResponse.status,
      statusText: cfResponse.statusText,
      headers: {
        "Content-Type": "text/event-stream", // Correct content type for SSE
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("API route error:", error);
    return new Response(
      JSON.stringify({
        error: (error instanceof Error ? error.message : String(error)) || "An unexpected error occurred",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
