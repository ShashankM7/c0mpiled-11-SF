import type { Metadata } from "next";
import { ProcureDemo } from "./ProcureDemo";

export const metadata: Metadata = {
  title: {
    absolute: "ProcureOS — The Agentic Purchasing Department",
  },
  description:
    "From request to approved-ready with supplier evidence, landed cost, and enforced spend authority at every step.",
};

export default function Home() {
  return <ProcureDemo />;
}
