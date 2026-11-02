import AuthGate from "@/components/AuthGate";
import PhotoViewer from "@/components/PhotoViewer";

export default function Home() {
  return <AuthGate><PhotoViewer /></AuthGate>;
}
