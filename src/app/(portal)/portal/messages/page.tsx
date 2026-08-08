import type { Metadata } from "next";
import { MessageList } from "@/components/portal/messages/MessageList";

export const metadata: Metadata = {
  title: "Messages",
};

export default function MessagesPage() {
  return <MessageList />;
}
