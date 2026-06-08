/**
 * Jest setup file — mocks Firebase Admin SDK and external dependencies
 * before any server code is loaded.
 *
 * Loaded via jest.config.js setupFiles — runs before every test file.
 * Jest globals (describe/it/expect/beforeAll) are NOT available here.
 */

// ─── Helper builders ────────────────────────────────────────────────

function buildDocSnapshot(data, exists) {
  if (typeof exists === "undefined") exists = true;
  return {
    exists: exists,
    data: function () { return exists ? data : null; },
    id: "mock_doc_id",
    ref: { path: "mock/path", update: jest.fn(), set: jest.fn(), delete: jest.fn() },
  };
}

function querySnapshot(docs) {
  if (!docs) docs = [];
  return {
    docs: docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: function (fn) { docs.forEach(fn); },
    data: function () { return { count: docs.length }; },
  };
}

// ─── Central data store for path-based lookups ──────────────────────
// Tests can set mockData["users/u1/orders/ord1"] = docSnapshot({...})
// and the mock chain will return it automatically.

var mockData = {};

function getSnapshotForPath(path) {
  if (mockData.hasOwnProperty(path)) return mockData[path];
  return buildDocSnapshot(null, false);
}

function buildDocRef(path) {
  return {
    id: (path || "").split("/").pop() || "mock",
    path: path || "mock",
    get: jest.fn(function () { return Promise.resolve(getSnapshotForPath(path)); }),
    set: jest.fn(function () { return Promise.resolve(); }),
    update: jest.fn(function () { return Promise.resolve(); }),
    delete: jest.fn(function () { return Promise.resolve(); }),
    collection: jest.fn(function (sub) { return buildCollectionRef((path || "") + "/" + sub); }),
  };
}

function buildCollectionRef(path) {
  var ref = {};
  var emptySnap = querySnapshot([]);
  ref.where = jest.fn(function () { return ref; });
  ref.limit = jest.fn(function () { return ref; });
  ref.orderBy = jest.fn(function () { return ref; });
  ref.startAfter = jest.fn(function () { return ref; });
  ref.get = jest.fn(function () {
    // For collection-level gets, find all entries under this path prefix
    var prefix = (path || "") + "/";
    var docs = [];
    Object.keys(mockData).forEach(function (k) {
      if (k.indexOf(prefix) === 0 && k.substr(prefix.length).indexOf("/") === -1) {
        docs.push(mockData[k]);
      }
    });
    return Promise.resolve(querySnapshot(docs));
  });
  ref.onSnapshot = jest.fn(function (cb) {
    if (cb) setTimeout(function () { cb({ docChanges: function () { return []; } }); }, 0);
    return jest.fn();
  });
  ref.add = jest.fn(function () { return Promise.resolve({ id: "mock_id_" + Date.now() }); });
  ref.doc = jest.fn(function (id) { return buildDocRef((path || "") + "/" + id); });
  return ref;
}

// ─── Firestore mock ─────────────────────────────────────────────────

var mockFirestore = {
  collection: jest.fn(function (name) { return buildCollectionRef(name); }),
  collectionGroup: jest.fn(function (name) { return buildCollectionRef(name); }),
  doc: jest.fn(function (path) { return buildDocRef(path); }),
  batch: jest.fn(function () {
    return {
      set: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      commit: jest.fn(function () { return Promise.resolve(); }),
    };
  }),
  runTransaction: jest.fn(function (fn) {
    var t = {
      get: jest.fn(function (p) {
        var path = p && p.path ? p.path : "mock";
        return Promise.resolve(getSnapshotForPath(path));
      }),
      set: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    return Promise.resolve(fn(t));
  }),
  settings: jest.fn(),
};

// ─── Auth mock ──────────────────────────────────────────────────────

var mockAuth = {
  verifyIdToken: jest.fn(function () {
    return Promise.resolve({ uid: "test_uid", email: "test@test.com", role: "user" });
  }),
  setCustomUserClaims: jest.fn(function () { return Promise.resolve(); }),
  getUser: jest.fn(function () {
    return Promise.resolve({ uid: "test_uid", customClaims: {} });
  }),
};

// ─── Messaging mock ─────────────────────────────────────────────────

var mockMessaging = {
  send: jest.fn(function () { return Promise.resolve("mock_message_id"); }),
  sendEachForMulticast: jest.fn(function () {
    return Promise.resolve({ responses: [{ success: true }] });
  }),
};

// ─── Expose to test files ───────────────────────────────────────────

global.__mockFirestore = mockFirestore;
global.__mockAuth = mockAuth;
global.__mockMessaging = mockMessaging;
global.__mockData = mockData;
global.__buildDocSnapshot = buildDocSnapshot;
global.__querySnapshot = querySnapshot;
global.__buildDocRef = buildDocRef;
global.__buildCollectionRef = buildCollectionRef;

// ─── Jest module mocks (factory scope: `mock` prefix vars allowed) ──

jest.mock("firebase-admin", function () {
  var _fs = mockFirestore;
  var _auth = mockAuth;
  var _msg = mockMessaging;
  var _fv = {
    increment: jest.fn(function (n) { return { _increment: n }; }),
    serverTimestamp: jest.fn(function () { return { _serverTimestamp: true }; }),
    arrayUnion: jest.fn(function (v) { return { _arrayUnion: v }; }),
    arrayRemove: jest.fn(function (v) { return { _arrayRemove: v }; }),
    deleteField: jest.fn(function () { return { _delete: true }; }),
  };
  var _firestore = function () { return _fs; };
  _firestore.FieldValue = _fv;
  return {
    initializeApp: jest.fn(),
    credential: {
      cert: jest.fn(function () { return {}; }),
      applicationDefault: jest.fn(function () { return {}; }),
    },
    firestore: _firestore,
    auth: function () { return _auth; },
    messaging: function () { return _msg; },
  };
});

jest.mock("firebase-admin/firestore", function () {
  var _fs = mockFirestore;
  return {
    FieldValue: {
      increment: jest.fn(function (n) { return { _increment: n }; }),
      serverTimestamp: jest.fn(function () { return { _serverTimestamp: true }; }),
      arrayUnion: jest.fn(function (v) { return { _arrayUnion: v }; }),
      arrayRemove: jest.fn(function (v) { return { _arrayRemove: v }; }),
      deleteField: jest.fn(function () { return { _delete: true }; }),
    },
    getFirestore: function () { return _fs; },
  };
});
