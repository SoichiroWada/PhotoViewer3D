import { loadPhotos, PhotoDirectoryError } from "@/lib/photoLoader";

export async function GET() {
  try {
    return Response.json(await loadPhotos(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Photo catalog unavailable:", error);
    return Response.json({ error: error instanceof PhotoDirectoryError ? error.message : "Unable to load photos." }, { status: 503 });
  }
}
