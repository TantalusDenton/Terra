import Link from "next/link";
import { Button } from "@/components/site-button";
export default function NotFound() {
  return (
    <section className="panel empty-state">
      <h1>Page not found.</h1>
      <p>The Assembly keeps Terra’s current public record.</p>
      <Button asChild>
        <Link href="/">Return to the Assembly</Link>
      </Button>
    </section>
  );
}
