const http = require("http");

const testEndpoint = (port, path) => {
  const options = {
    hostname: "localhost",
    port: port,
    path: path,
    method: "GET",
    headers: {
      "Content-Type": "application/json"
      // Note: we can skip auth for simple check if it throws 401 or works
    }
  };

  const req = http.request(options, (res) => {
    console.log(`Port ${port} Path ${path} status:`, res.statusCode);
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      console.log("Response data (truncated):", data.substring(0, 300));
    });
  });

  req.on("error", (err) => {
    console.error(`Error connecting to Port ${port} Path ${path}:`, err.message);
  });

  req.end();
};

console.log("Checking microservice connections...");
testEndpoint(3005, "/api/docs");
testEndpoint(3000, "/api/docs");
