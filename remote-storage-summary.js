const fs = require("fs/promises");
const path = require("path");

const FILE_ROOT = process.env.FILE_ROOT || "/home/ubuntu";

function toRemotePath(absolutePath) {
  const relative = path.relative(FILE_ROOT, absolutePath).replace(/\\/g, "/");
  return relative ? `/${relative}` : "/";
}

function detectCategory(fileName) {
  const extension = path.extname(fileName).toLowerCase();

  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"].includes(extension)) {
    return "images";
  }

  if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"].includes(extension)) {
    return "videos";
  }

  if ([".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".xls", ".xlsx", ".csv", ".ppt", ".pptx"].includes(extension)) {
    return "documents";
  }

  return "others";
}

async function scanUsage(absolutePath) {
  const stats = await fs.lstat(absolutePath);

  if (stats.isSymbolicLink()) {
    return {
      totalSize: 0,
      categories: { documents: 0, images: 0, videos: 0, others: 0 }
    };
  }

  if (stats.isFile()) {
    const category = detectCategory(absolutePath);

    return {
      totalSize: stats.size,
      categories: {
        documents: category === "documents" ? stats.size : 0,
        images: category === "images" ? stats.size : 0,
        videos: category === "videos" ? stats.size : 0,
        others: category === "others" ? stats.size : 0
      }
    };
  }

  if (!stats.isDirectory()) {
    return {
      totalSize: stats.size || 0,
      categories: {
        documents: 0,
        images: 0,
        videos: 0,
        others: stats.size || 0
      }
    };
  }

  const children = await fs.readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    children.map((child) => scanUsage(path.join(absolutePath, child.name)))
  );

  return nested.reduce(
    (total, item) => ({
      totalSize: total.totalSize + item.totalSize,
      categories: {
        documents: total.categories.documents + item.categories.documents,
        images: total.categories.images + item.categories.images,
        videos: total.categories.videos + item.categories.videos,
        others: total.categories.others + item.categories.others
      }
    }),
    {
      totalSize: 0,
      categories: { documents: 0, images: 0, videos: 0, others: 0 }
    }
  );
}

async function getStorageSummary() {
  const stat = await fs.statfs(FILE_ROOT);
  const blockSize = stat.bsize || stat.frsize || 4096;

  const totalSpace = stat.blocks * blockSize;
  const availableSpace = stat.bavail * blockSize;
  const usedSpace = totalSpace - stat.bfree * blockSize;

  const entries = await fs.readdir(FILE_ROOT, { withFileTypes: true });

  const projects = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(FILE_ROOT, entry.name);
      const usage = await scanUsage(absolute);

      return {
        name: entry.name,
        type: entry.isDirectory() ? "folder" : "file",
        size: usage.totalSize,
        path: toRemotePath(absolute)
      };
    })
  );

  const rootUsage = await scanUsage(FILE_ROOT);
  const sortedProjects = projects.sort((a, b) => b.size - a.size);

  return {
    fileRoot: FILE_ROOT,
    totalSpace,
    usedSpace,
    availableSpace,
    categories: rootUsage.categories,
    projects: sortedProjects,
    topProjects: sortedProjects.slice(0, 8)
  };
}

(async () => {
  const data = await getStorageSummary();
  process.stdout.write(JSON.stringify(data));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
