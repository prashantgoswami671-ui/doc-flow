import Navbar from "../components/Navbar";
import Hero from "../components/Hero";
import ExtractPagesCard from "../components/ExtractPagesCard";
import DeletePagesCard from "../components/DeletePagesCard";
import FixPageOrientationCard from "../components/FixPageOrientationCard";
import UploadCard from "../components/UploadCard";

export default function Home() {
  return (
    <>
      <Navbar />
      <Hero />
      <section className="pb-20 -mt-8">
        <UploadCard />
      </section>
      <section className="pb-20">
        <ExtractPagesCard />
      </section>
      <section className="pb-20">
        <DeletePagesCard />
      </section>
      <section className="pb-20">
        <FixPageOrientationCard />
      </section>
    </>
  );
}
