// one-click-deployment-demo
// Simple demo of a Node.js application that handles deployments to AWS using SDK v3

// Required packages:
// npm install express @aws-sdk/client-ecr @aws-sdk/client-ecs dotenv simple-git child_process

// File: app.js
const express = require("express");
const dotenv = require("dotenv");
const simpleGit = require("simple-git");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

// Middleware
// Add this line to enable CORS
// Import specific AWS SDK v3 clients
const {
  ECRClient,
  GetAuthorizationTokenCommand,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
} = require("@aws-sdk/client-ecr");
const {
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  CreateServiceCommand,
} = require("@aws-sdk/client-ecs");

// Load environment variables
dotenv.config();

// Configure AWS SDK v3 clients
const region = process.env.AWS_REGION || "us-east-1";
const ecrClient = new ECRClient({ region });
const ecsClient = new ECSClient({ region });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static("public"));
app.use(cors());

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API endpoint to trigger deployments
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, branch, appName } = req.body;

    console.log("Request received:", req.body);

    if (!repoUrl || !branch || !appName) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: repoUrl, branch, or appName",
      });
    }

    // Create unique deployment ID
    const deploymentId = `${appName}-${Date.now()}`;
    console.log(
      `Starting deployment ${deploymentId} from ${repoUrl} (${branch})`
    );

    // Start the deployment process asynchronously
    deployApplication(deploymentId, repoUrl, branch, appName)
      .then(() =>
        console.log(`Deployment ${deploymentId} completed successfully`)
      )
      .catch((err) => console.error(`Deployment ${deploymentId} failed:`, err));

    // Immediately return response
    return res.status(202).json({
      success: true,
      message: "Deployment started",
      deploymentId,
    });
  } catch (error) {
    console.error("Error initiating deployment:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to initiate deployment",
      error: error.message,
    });
  }
});

// API endpoint to check deployment status
app.get("/api/deployment/:deploymentId", (req, res) => {
  const { deploymentId } = req.params;
  // In a real implementation, you would check the status from a database
  // This is just a placeholder
  res.json({
    deploymentId,
    status: "in_progress",
    message: "Deployment in progress",
  });
});

// Main deployment function
async function deployApplication(deploymentId, repoUrl, branch, appName) {
  try {
    // Step 1: Clone the repository
    const workDir = path.join(__dirname, "deployments", deploymentId);
    fs.mkdirSync(workDir, { recursive: true });

    console.log(`Cloning ${repoUrl} (${branch}) to ${workDir}...`);
    const git = simpleGit();
    await git.clone(repoUrl, workDir);
    await git.cwd(workDir).checkout(branch);

    // Step 2: Build the Docker image
    console.log("Building Docker image...");
    const imageTag = `${appName}:${deploymentId}`;
    execSync(`docker build -t ${imageTag} .`, { cwd: workDir });

    // Step 3: Push to ECR
    console.log("Pushing image to ECR...");
    const ecrRepo = await getOrCreateECRRepo(appName);
    const ecrUri = `${ecrRepo.repositoryUri}:latest`;

    // Login to ECR
    const authData = await getECRAuthToken();
    const [username, password] = authData.split(":");
    const ecrDomain = ecrRepo.repositoryUri.split("/")[0];
    execSync(`docker login -u ${username} -p ${password} ${ecrDomain}`);

    // Tag and push image
    execSync(`docker tag ${imageTag} ${ecrUri}`);
    execSync(`docker push ${ecrUri}`);

    // Step 4: Update ECS service
    console.log("Updating ECS service...");
    await updateECSService(appName, ecrUri);

    console.log(`Deployment completed for ${deploymentId}`);
    return { success: true, message: "Deployment successful" };
  } catch (error) {
    console.error(`Deployment failed for ${deploymentId}:`, error);
    throw error;
  }
}

// Helper function to get ECR auth token
async function getECRAuthToken() {
  const command = new GetAuthorizationTokenCommand({});
  const response = await ecrClient.send(command);
  const token = response.authorizationData[0].authorizationToken;
  return Buffer.from(token, "base64").toString("utf-8");
}

// Helper function to get or create ECR repository
async function getOrCreateECRRepo(appName) {
  try {
    const command = new DescribeRepositoriesCommand({
      repositoryNames: [appName],
    });
    const response = await ecrClient.send(command);
    return response.repositories[0];
  } catch (error) {
    if (error.name === "RepositoryNotFoundException") {
      const createCommand = new CreateRepositoryCommand({
        repositoryName: appName,
      });
      const createResponse = await ecrClient.send(createCommand);
      return createResponse.repository;
    }
    throw error;
  }
}

// Helper function to update ECS service
async function updateECSService(appName, imageUri) {
  // Step 1: Get cluster name
  const clusterName = process.env.ECS_CLUSTER || "default";

  // Step 2: Register new task definition with updated image
  const registerTaskCommand = new RegisterTaskDefinitionCommand({
    family: appName,
    executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN,
    taskRoleArn: process.env.ECS_TASK_ROLE_ARN,
    networkMode: "awsvpc",
    containerDefinitions: [
      {
        name: appName,
        image: imageUri,
        essential: true,
        portMappings: [
          {
            containerPort: 3000,
            hostPort: 3000,
            protocol: "tcp",
          },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/ecs/${appName}`,
            "awslogs-region": process.env.AWS_REGION || "us-east-1",
            "awslogs-stream-prefix": "ecs",
          },
        },
      },
    ],
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
  });

  const taskDefResponse = await ecsClient.send(registerTaskCommand);

  // Step 3: Update or create the service with new task definition
  try {
    const updateCommand = new UpdateServiceCommand({
      cluster: clusterName,
      service: appName,
      taskDefinition: taskDefResponse.taskDefinition.taskDefinitionArn,
    });

    await ecsClient.send(updateCommand);
    console.log(`Updated service ${appName} with new task definition`);
  } catch (error) {
    if (error.name === "ServiceNotFoundException") {
      // Service doesn't exist, create it
      const createCommand = new CreateServiceCommand({
        cluster: clusterName,
        serviceName: appName,
        taskDefinition: taskDefResponse.taskDefinition.taskDefinitionArn,
        desiredCount: 1,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: process.env.ECS_SUBNETS.split(","),
            securityGroups: process.env.ECS_SECURITY_GROUPS.split(","),
            assignPublicIp: "ENABLED",
          },
        },
      });

      await ecsClient.send(createCommand);
      console.log(`Created new service ${appName}`);
    } else {
      throw error;
    }
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`One-Click Deployment server running on port ${PORT}`);
});
