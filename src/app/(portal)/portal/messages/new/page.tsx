import type { Metadata } from "next";
import { NewMessage } from "@/components/portal/messages/NewMessage";

export const metadata: Metadata = {
  title: "New Message",
};

export default function NewMessagePage() {
  return <NewMessage />;
}
