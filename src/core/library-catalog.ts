const STORE = "https://gibranalcocer.com/products/";

export const LIBRARY_CATALOG = [
  [1, "idea-1-music-score"], [2, "idea-2-gibran-alcocer-sheet-music-piano-solo"], [5, "idea-5-sheet-music"],
  [7, "idea-7-sheet-music"], [9, "idea-9-music-score"], [10, "idea-10-sheet-music"],
  [12, "idea-12-gibran-alcocer-sheet-music-piano"], [15, "idea-15-sheet-music"], [20, "idea-20-sheet-music"],
  [22, "idea-22-music-score"], [25, "idea-25-piano-solo-version-sheet-music"],
].map(([number, path]) => ({ title: `Idea ${number}`, artist: "Gibran Alcocer", url: STORE + path }));
