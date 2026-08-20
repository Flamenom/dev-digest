/* Route: /skills/new — blank Config form; on create → redirect to /skills/[id]. */
import { NewSkillForm } from "./_components/NewSkillForm";

export default function NewSkillPage() {
  return <NewSkillForm />;
}
