const GITHUB_OWNER = "jdjvhhdhcvbc-byte";
const GITHUB_REPO = "Minecraft-Mod-Hub";
const MODS_FILE = "data/mods.json";

const ALLOWED_ORIGINS = "*";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      // Health check
      if (url.pathname === "/" && request.method === "GET") {
        return json({
          success: true,
          service: "Minecraft Mod Hub API",
          status: "online"
        });
      }

      // Public mods list
      if (url.pathname === "/api/mods" && request.method === "GET") {
        return await getMods(env);
      }

      // Protected admin API
      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAuthorized(request, env)) {
          return json(
            {
              success: false,
              error: "Unauthorized"
            },
            401
          );
        }

        if (url.pathname === "/api/admin/mods" && request.method === "POST") {
          return await addMod(request, env);
        }

        if (url.pathname === "/api/admin/mods" && request.method === "PUT") {
          return await updateMod(request, env);
        }

        if (url.pathname === "/api/admin/mods" && request.method === "DELETE") {
          return await deleteMod(request, env);
        }

        if (
          url.pathname === "/api/admin/upload" &&
          request.method === "POST"
        ) {
          return await uploadFile(request, env);
        }
      }

      return json(
        {
          success: false,
          error: "Not found"
        },
        404
      );
    } catch (error) {
      return json(
        {
          success: false,
          error: error?.message || "Internal server error"
        },
        500
      );
    }
  }
};


// ============================================================
// PUBLIC MODS
// ============================================================

async function getMods(env) {
  const result = await githubGetFile(MODS_FILE, env);

  if (!result.ok) {
    return json({
      success: true,
      mods: []
    });
  }

  let data;

  try {
    data = JSON.parse(result.content);
  } catch {
    data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      mods: []
    };
  }

  if (!Array.isArray(data.mods)) {
    data.mods = [];
  }

  // Only return published mods to public users
  const publicMods = data.mods.filter(mod => mod.published !== false);

  return json({
    success: true,
    version: data.version || 1,
    updatedAt: data.updatedAt || null,
    mods: publicMods
  });
}


// ============================================================
// ADD MOD
// ============================================================

async function addMod(request, env) {
  const body = await request.json();

  validateMod(body);

  const data = await getModsFileForAdmin(env);

  if (data.mods.some(mod => mod.id === body.id)) {
    return json(
      {
        success: false,
        error: "A mod with this ID already exists."
      },
      409
    );
  }

  const mod = {
    ...body,
    id: String(body.id),
    published: body.published !== false,
    featured: body.featured === true,
    createdAt: body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.mods.push(mod);
  data.updatedAt = new Date().toISOString();

  const saved = await saveMods(data, env);

  if (!saved.ok) {
    return json(
      {
        success: false,
        error: saved.error
      },
      500
    );
  }

  return json({
    success: true,
    message: "Mod added successfully.",
    mod
  });
}


// ============================================================
// UPDATE MOD
// ============================================================

async function updateMod(request, env) {
  const body = await request.json();

  if (!body.id) {
    return json(
      {
        success: false,
        error: "Mod ID is required."
      },
      400
    );
  }

  const data = await getModsFileForAdmin(env);

  const index = data.mods.findIndex(
    mod => String(mod.id) === String(body.id)
  );

  if (index === -1) {
    return json(
      {
        success: false,
        error: "Mod not found."
      },
      404
    );
  }

  data.mods[index] = {
    ...data.mods[index],
    ...body,
    id: data.mods[index].id,
    updatedAt: new Date().toISOString()
  };

  data.updatedAt = new Date().toISOString();

  const saved = await saveMods(data, env);

  if (!saved.ok) {
    return json(
      {
        success: false,
        error: saved.error
      },
      500
    );
  }

  return json({
    success: true,
    message: "Mod updated successfully.",
    mod: data.mods[index]
  });
}


// ============================================================
// DELETE MOD
// ============================================================

async function deleteMod(request, env) {
  const body = await request.json();

  if (!body.id) {
    return json(
      {
        success: false,
        error: "Mod ID is required."
      },
      400
    );
  }

  const data = await getModsFileForAdmin(env);

  const oldLength = data.mods.length;

  data.mods = data.mods.filter(
    mod => String(mod.id) !== String(body.id)
  );

  if (data.mods.length === oldLength) {
    return json(
      {
        success: false,
        error: "Mod not found."
      },
      404
    );
  }

  data.updatedAt = new Date().toISOString();

  const saved = await saveMods(data, env);

  if (!saved.ok) {
    return json(
      {
        success: false,
        error: saved.error
      },
      500
    );
  }

  return json({
    success: true,
    message: "Mod deleted successfully."
  });
}


// ============================================================
// UPLOAD FILE TO GITHUB
// ============================================================

async function uploadFile(request, env) {
  const body = await request.json();

  if (!body.path || !body.contentBase64) {
    return json(
      {
        success: false,
        error: "path and contentBase64 are required."
      },
      400
    );
  }

  const path = sanitizePath(body.path);

  if (!path) {
    return json(
      {
        success: false,
        error: "Invalid file path."
      },
      400
    );
  }

  const content = body.contentBase64;

  if (content.length > 12000000) {
    return json(
      {
        success: false,
        error: "File is too large for this upload endpoint."
      },
      413
    );
  }

  const existing = await githubGetFile(path, env);

  const payload = {
    message: body.message || `Upload ${path}`,
    content: content
  };

  if (existing.ok && existing.sha) {
    payload.sha = existing.sha;
  }

  const response = await githubRequest(
    `/contents/${encodeURIComponentPath(path)}`,
    env,
    {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    return json(
      {
        success: false,
        error: result.message || "GitHub upload failed."
      },
      response.status
    );
  }

  return json({
    success: true,
    message: "File uploaded successfully.",
    path,
    sha: result.content?.sha || null,
    downloadUrl:
      result.content?.download_url ||
      `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/${path}`
  });
}


// ============================================================
// GITHUB MODS.JSON
// ============================================================

async function getModsFileForAdmin(env) {
  const result = await githubGetFile(MODS_FILE, env);

  if (!result.ok) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      mods: []
    };
  }

  try {
    const data = JSON.parse(result.content);

    if (!Array.isArray(data.mods)) {
      data.mods = [];
    }

    return data;
  } catch {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      mods: []
    };
  }
}


async function saveMods(data, env) {
  const existing = await githubGetFile(MODS_FILE, env);

  const content = JSON.stringify(data, null, 2);

  const payload = {
    message: "Update mods.json",
    content: toBase64(content)
  };

  if (existing.ok && existing.sha) {
    payload.sha = existing.sha;
  }

  const response = await githubRequest(
    `/contents/${encodeURIComponentPath(MODS_FILE)}`,
    env,
    {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const error = await response.text();

    return {
      ok: false,
      error
    };
  }

  return {
    ok: true
  };
}


// ============================================================
// GITHUB API
// ============================================================

async function githubGetFile(path, env) {
  const response = await githubRequest(
    `/contents/${encodeURIComponentPath(path)}`,
    env,
    {
      method: "GET"
    }
  );

  if (response.status === 404) {
    return {
      ok: false,
      status: 404
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status
    };
  }

  const data = await response.json();

  let content = "";

  if (data.content) {
    content = fromBase64(
      data.content.replace(/\n/g, "")
    );
  }

  return {
    ok: true,
    content,
    sha: data.sha || null
  };
}


async function githubRequest(path, env, options = {}) {
  return fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`,
    {
      ...options,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Minecraft-Mod-Hub-Cloudflare-Worker",
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );
}


// ============================================================
// SECURITY
// ============================================================

function isAuthorized(request, env) {
  const key =
    request.headers.get("X-Admin-Key") ||
    request.headers.get("Authorization")?.replace(
      /^Bearer\s+/i,
      ""
    );

  if (!key || !env.ADMIN_KEY) {
    return false;
  }

  return key === env.ADMIN_KEY;
}


// ============================================================
// VALIDATION
// ============================================================

function validateMod(mod) {
  if (!mod.id) {
    throw new Error("Mod ID is required.");
  }

  if (!mod.name) {
    throw new Error("Mod name is required.");
  }

  if (!mod.downloadUrl && !mod.filePath) {
    throw new Error(
      "downloadUrl or filePath is required."
    );
  }
}


function sanitizePath(path) {
  path = String(path || "").trim();

  if (!path) return null;

  if (
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("//")
  ) {
    return null;
  }

  return path;
}


function encodeURIComponentPath(path) {
  return path
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}


// ============================================================
// BASE64 UTF-8
// ============================================================

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);

  let binary = "";

  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}


function fromBase64(base64) {
  const binary = atob(base64);

  const bytes = Uint8Array.from(
    binary,
    char => char.charCodeAt(0)
  );

  return new TextDecoder().decode(bytes);
}


// ============================================================
// RESPONSE
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, Authorization",
    "Cache-Control": "no-cache"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders()
      }
    }
  );
}
