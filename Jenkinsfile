pipeline {
  agent any

  environment {
    AWS_REGION   = 'ap-south-1'          // CHANGE if you use another region
    CLUSTER_NAME = 'shopflow-cluster'    // CHANGE to your EKS cluster name
    ACCOUNT_ID   = sh(script: 'aws sts get-caller-identity --query Account --output text', returnStdout: true).trim()
    REGISTRY     = "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    TAG          = "${env.BUILD_NUMBER}"
  }

  stages {
    stage('Get code') {
      steps { checkout scm }
    }

    stage('Run tests') {
      steps {
        // Tests run inside a throw-away Node container, so Jenkins itself needs no Node.
        sh 'docker run --rm -v "$PWD/backend:/app" -w /app node:20-alpine sh -c "npm install && npm test"'
      }
    }

    stage('Build images') {
      steps {
        sh 'docker build -t $REGISTRY/shopflow-backend:$TAG  backend'
        sh 'docker build -t $REGISTRY/shopflow-frontend:$TAG frontend'
      }
    }

    stage('Push images to ECR') {
      steps {
        sh '''
          aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY
          docker push $REGISTRY/shopflow-backend:$TAG
          docker push $REGISTRY/shopflow-frontend:$TAG
        '''
      }
    }

    stage('Deploy to Kubernetes') {
      steps {
        sh '''
          aws eks update-kubeconfig --region $AWS_REGION --name $CLUSTER_NAME
          kubectl apply -f k8s/00-namespace.yaml
          sed "s|__REGISTRY__|$REGISTRY|g; s|__TAG__|$TAG|g" k8s/10-backend.yaml  | kubectl apply -f -
          sed "s|__REGISTRY__|$REGISTRY|g; s|__TAG__|$TAG|g" k8s/20-frontend.yaml | kubectl apply -f -
          kubectl -n shopflow rollout status deployment/backend  --timeout=180s
          kubectl -n shopflow rollout status deployment/frontend --timeout=180s
        '''
      }
    }
  }

  post {
    success { echo "Deployed build ${TAG}. Run: kubectl -n shopflow get svc frontend" }
    failure { echo 'Build failed. Open "Console Output" and read the first red error.' }
  }
}
