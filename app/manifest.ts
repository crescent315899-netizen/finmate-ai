import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return { id: "/", name: "FinMate AI", short_name: "FinMate", description: "Clearer money decisions.", start_url: "/", scope: "/", display: "standalone", background_color: "#f7f6f2", theme_color: "#102a43", icons: [{ src: "/icons/finmate-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }, { src: "/icons/finmate-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }] };
}
