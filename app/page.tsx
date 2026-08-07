import Navbar from "../components/Navbar";
import Hero from "../components/Hero";
import UploadCard from "../components/UploadCard";

export default function Home() {
  return (
    <>
      <Navbar />
      <Hero />
      <section className="pb-20 -mt-8">
        <UploadCard />
      </section>
    </>
  );
}