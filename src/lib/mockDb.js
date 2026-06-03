// backend/src/lib/mockDb.js
const fs = require("fs");
const path = require("path");

const storePath = path.resolve(__dirname, "mockDb_store.json");

const defaultDb = {
  users: [
    {
      id: "mock-user-karthik",
      email: "karthik245322748042@gmail.com",
      fullName: "Karthik Mareddy",
      passwordHash: "$2b$10$r845X4F9.TfG0W9kK7kQhO9Q6G5mQO6iE.1m825L07f4G1qO6G5mQ" // bcrypt mock hash
    },
    {
      id: "mock-user-receiver",
      email: "mareddykarthikeya@gmail.com",
      fullName: "Karthikeya Mareddy",
      passwordHash: "$2b$10$r845X4F9.TfG0W9kK7kQhO9Q6G5mQO6iE.1m825L07f4G1qO6G5mQ"
    },
    {
      id: "demo-user",
      email: "demo@wavework.ai",
      fullName: "Demo User",
      passwordHash: "$2b$10$r845X4F9.TfG0W9kK7kQhO9Q6G5mQO6iE.1m825L07f4G1qO6G5mQ"
    }
  ],

  organizations: [
    {
      id: "mock-org",
      name: "WaveWork.ai Org",
      slug: "wavework-ai-org"
    }
  ],

  workspaces: [
    {
      id: "demo-ws",
      orgId: "mock-org",
      name: "WaveWork Workspace",
      color: "#4F46E5",
      icon: "Briefcase"
    }
  ],

  spaces: [
    {
      id: "demo-space",
      workspaceId: "demo-ws",
      name: "Engineering Space",
      color: "#4F46E5",
      icon: "Code",
      position: 0
    }
  ],

  statuses: [
    { id: "todo-status", spaceId: "demo-space", name: "TO DO", color: "#8E8E93", position: 0 },
    { id: "inprogress-status", spaceId: "demo-space", name: "IN PROGRESS", color: "#4F46E5", position: 1 },
    { id: "done-status", spaceId: "demo-space", name: "COMPLETE", color: "#10B981", position: 2 }
  ],

  lists: [
    {
      id: "demo-list",
      spaceId: "demo-space",
      name: "Sprint Backlog",
      position: 0,
      folderId: null
    }
  ],

  tasks: [
    {
      id: "mock-task-1",
      listId: "demo-list",
      name: "Design ClickUp Unified Dashboards",
      description: "Build Inbox, Replies, Assigned Comments, My Tasks, and Personal Space views.",
      priority: "HIGH",
      dueDate: new Date(Date.now() + 86400000 * 2),
      statusId: "inprogress-status",
      position: 0
    },
    {
      id: "mock-task-2",
      listId: "demo-list",
      name: "Implement Real-time DM Status Presence",
      description: "Connect WebSocket identify events and show green status dots.",
      priority: "URGENT",
      dueDate: new Date(),
      statusId: "todo-status",
      position: 1
    }
  ],

  comments: [],

  channels: [],

  inbox: [],

  messages: [],

  timeEntries: [],
  docs: [],
  folders: [],
  spaceMembers: []
};

function readDb() {
  try {
    if (fs.existsSync(storePath)) {
      const content = fs.readFileSync(storePath, "utf8");
      const data = JSON.parse(content);
      // Cleanly merge defaultDb so that any new properties (like docs) are guaranteed to exist
      return { ...defaultDb, ...data };
    }
  } catch (e) {
    console.error("Error reading mockDb_store.json, using default", e);
  }
  return defaultDb;
}

function writeDb(data) {
  try {
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Error writing mockDb_store.json", e);
  }
}

// Initialize store file if missing
if (!fs.existsSync(storePath)) {
  writeDb(defaultDb);
}

let dbInMemory = readDb();

// Deep recursive proxy wrapper to intercept array mutating methods (push, splice, etc.) and deep assignments
function makeObservable(val, onWrite) {
  if (Array.isArray(val)) {
    return new Proxy(val, {
      get(target, prop, receiver) {
        const item = Reflect.get(target, prop, receiver);
        if (typeof item === "function") {
          const mutatingMethods = ["push", "pop", "shift", "unshift", "splice", "reverse", "sort", "fill"];
          if (mutatingMethods.includes(prop)) {
            return function(...args) {
              const res = item.apply(target, args);
              onWrite();
              return res;
            };
          }
        }
        if (typeof item === "object" && item !== null) {
          return makeObservable(item, onWrite);
        }
        return item;
      },
      set(target, prop, value, receiver) {
        const res = Reflect.set(target, prop, value, receiver);
        onWrite();
        return res;
      }
    });
  } else if (val !== null && typeof val === "object") {
    return new Proxy(val, {
      get(target, prop, receiver) {
        const item = Reflect.get(target, prop, receiver);
        if (typeof item === "object" && item !== null) {
          return makeObservable(item, onWrite);
        }
        return item;
      },
      set(target, prop, value, receiver) {
        const res = Reflect.set(target, prop, value, receiver);
        onWrite();
        return res;
      }
    });
  }
  return val;
}

const mockDb = new Proxy({}, {
  get(target, prop) {
    dbInMemory = readDb();
    const val = dbInMemory[prop];
    if (typeof val === "object" && val !== null) {
      return makeObservable(val, () => {
        writeDb(dbInMemory);
      });
    }
    return val;
  },
  set(target, prop, value) {
    dbInMemory[prop] = value;
    writeDb(dbInMemory);
    return true;
  }
});

module.exports = { mockDb };
