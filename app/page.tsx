import { redirect } from "next/navigation";

// Landing page removed — staff screen is now the entry point.
// Kiosk machine links are available directly from the staff screen header.
export default function Home() {
  redirect("/staff");
}
