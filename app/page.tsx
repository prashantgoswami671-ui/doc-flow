import Navbar from "../components/Navbar";
import Hero from "../components/Hero";
import ExtractPagesCard from "../components/ExtractPagesCard";
import OrganizePagesCard from "../components/OrganizePagesCard";
import FixPageOrientationCard from "../components/FixPageOrientationCard";
import MergePdfCard from "../components/MergePdfCard";
import SplitPdfCard from "../components/SplitPdfCard";
import InsertPagesCard from "../components/InsertPagesCard";
import MetadataEditorCard from "../components/MetadataEditorCard";
import WatermarkPdfCard from "../components/WatermarkPdfCard";
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
        <OrganizePagesCard />
      </section>
      <section className="pb-20">
        <MergePdfCard />
      </section>
      <section className="pb-20">
        <SplitPdfCard />
      </section>
      <section className="pb-20">
        <InsertPagesCard />
      </section>
      <section className="pb-20">
        <MetadataEditorCard />
      </section>
      <section className="pb-20">
        <FixPageOrientationCard />
      </section>
      <section className="pb-20">
        <WatermarkPdfCard />
      </section>
    </>
  );
}
