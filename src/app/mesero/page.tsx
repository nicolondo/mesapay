import { redirect } from "next/navigation";

// /mesero is just an entry point — push everyone to the default tab.
export default function MeseroRoot() {
  redirect("/mesero/salon");
}
