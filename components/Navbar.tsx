export default function Navbar() {
  return (
    <nav className="w-full bg-blue-600 text-white p-4">
      <div className="max-w-6xl mx-auto flex justify-between items-center">
        <h1 className="text-2xl font-bold">DocFlow</h1>

        <div className="flex gap-6">
          <a href="#">Home</a>
          <a href="#">Compress PDF</a>
          <a href="#">About</a>
        </div>
      </div>
    </nav>
  );
}