# ShopFlow on AWS — Step-by-Step Guide (plain language)

You will build a small online-shop system and put it on AWS using **Docker, Kubernetes (EKS), Jenkins and nginx**, with a **PostgreSQL database (RDS)** underneath. Everything is done in the **AWS console** (the website), plus a few commands.

---

## 0. The big picture (read this first)

Think of a restaurant:

| Restaurant | In this project | What it really does |
|---|---|---|
| Front door and waiter | **nginx** | Shows the web page and passes orders to the kitchen |
| Kitchen | **Backend API (Node.js)** | Applies the rules: checks stock, saves orders |
| Pantry and record book | **PostgreSQL (RDS)** | Stores customers, products, orders safely |
| Shipping box for the kitchen | **Docker image** | The app packed with everything it needs, so it runs the same everywhere |
| Restaurant manager | **Kubernetes (EKS)** | Keeps 2 copies of everything running, restarts crashed ones, updates without closing |
| Delivery truck + warehouse | **ECR** | Warehouse (storage) for Docker images |
| Robot that does the chores | **Jenkins** | When you save code: tests it, packs it, stores it, tells Kubernetes to use it |

**Flow of one visitor:** Browser → AWS Load Balancer → nginx → Backend → Database.

**Flow of one code change:** You push code to GitHub → Jenkins notices → runs tests → builds Docker images → pushes them to ECR → tells Kubernetes to run the new version.

---

## 1. Cost warning (important)

This setup is **not free-tier**. EKS charges for the "control room" by the hour, plus 2 servers, a load balancer, the Jenkins server and the database. Roughly **a few US dollars per day** in total (check current prices on the AWS pricing pages).

**Do it all in 1–2 days and follow Section 13 (Clean-up) the same day you finish.** Before you start, set a budget alert (Step 2).

---

## 2. Prepare your AWS account

1. Sign in to <https://console.aws.amazon.com>.
2. Top-right corner: choose a **Region**. This guide uses **Asia Pacific (Mumbai) `ap-south-1`**. Use the same region for *everything*. If you switch, you will "lose" your resources from view.
3. **Budget alert:** search **Billing and Cost Management** → **Budgets** → **Create budget** → *Use a template* → **Monthly cost budget** → amount **10 USD** → add your email → Create.
4. **Put the project on GitHub** (Jenkins fetches the code from there):
   - Create a free account at github.com → **New repository** → name `shopflow` → **Public** (simplest) → Create.
   - On your computer, unzip the project, open a terminal in the `shopflow` folder and run:
     ```bash
     git init
     git add .
     git commit -m "first version"
     git branch -M main
     git remote add origin https://github.com/YOUR_NAME/shopflow.git
     git push -u origin main
     ```
   - Never put passwords in the code. This project keeps the DB password out of GitHub on purpose.

---

## 3. Create two security groups ("door locks")

A **security group** is a list of who may knock on which door. Create these two **now** so later steps can refer to them.

Console → **EC2** → left menu **Security Groups** → **Create security group** (use the *default VPC*).

**Group 1: `jenkins-sg`**
- Inbound rule 1: Type **SSH**, port 22, Source **Anywhere-IPv4** (needed so the console's "Connect" button works; you will delete this rule at clean-up).
- Inbound rule 2: Type **Custom TCP**, port **8080**, Source **My IP** (only your computer can open Jenkins).

**Group 2: `rds-sg`**
- Add no rules yet. We will add them in Step 7.

---

## 4. Create the database (RDS PostgreSQL)

1. Console → **RDS** → **Create database**.
2. **Standard create** → Engine **PostgreSQL**.
3. **Templates:** choose **Free tier** (if you don't see it, choose **Dev/Test** and pick the smallest size).
4. **DB instance identifier:** `shopflow-db`
5. **Master username:** `shopadmin`. **Self managed** password: use **letters and numbers only** (e.g. `ShopFlow2026Pass`). Special characters can break the connection address later.
6. **Instance class:** `db.t3.micro` (or `db.t4g.micro`).
7. **Storage:** 20 GB is fine. Untick *storage autoscaling* if you want to control cost.
8. **Connectivity:** *Don't connect to an EC2 compute resource* → default VPC → **Public access: No** → **Existing security group**: remove `default`, select **`rds-sg`**.
9. Open **Additional configuration** → **Initial database name:** `shopflow` (don't skip this).
10. **Create database.** Wait about 5–10 minutes until status is **Available**.
11. Click the database → copy the **Endpoint** (like `shopflow-db.xxxx.ap-south-1.rds.amazonaws.com`). Save it in a notepad.

> The tables are created automatically when the backend first starts. You don't need to run SQL by hand.

---

## 5. Create two image storage boxes (ECR)

1. Console → **Elastic Container Registry** → **Create repository**.
2. **Private**, name **`shopflow-backend`** → Create.
3. Repeat with name **`shopflow-frontend`**.

---

## 6. Create three IAM roles (permission badges)

A **role** is a badge that lets an AWS service do things for you.

Console → **IAM** → **Roles** → **Create role**.

**Role A: `jenkins-role`** (badge for the Jenkins server)
1. Trusted entity: **AWS service** → Use case **EC2** → Next.
2. Add permission: **AmazonEC2ContainerRegistryPowerUser** → Next → name `jenkins-role` → Create.
3. Open the role → **Add permissions** → **Create inline policy** → **JSON** tab → paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["eks:DescribeCluster", "eks:ListClusters"], "Resource": "*" }
     ]
   }
   ```
   → name `jenkins-eks-describe` → Create policy.

**Role B: `eks-cluster-role`** (badge for the Kubernetes control room)
1. Trusted entity **AWS service** → in the *Use case* drop-down choose **EKS** → **EKS - Cluster** → Next.
2. `AmazonEKSClusterPolicy` is already selected → Next → name `eks-cluster-role` → Create.

**Role C: `eks-node-role`** (badge for the worker servers)
1. Trusted entity **AWS service** → Use case **EC2** → Next.
2. Tick these three: **AmazonEKSWorkerNodePolicy**, **AmazonEKS_CNI_Policy**, **AmazonEC2ContainerRegistryReadOnly** → Next → name `eks-node-role` → Create.

---

## 7. Create the Kubernetes cluster (EKS)

### 7a. The control room
1. Console → **Elastic Kubernetes Service** → **Create cluster**.
2. Choose **Custom configuration**. **Turn OFF "Use EKS Auto Mode"** (we want the classic setup with our own worker servers).
3. **Name:** `shopflow-cluster`. **Cluster IAM role:** `eks-cluster-role`. Keep the default Kubernetes version → Next.
4. **Networking:** default VPC, keep all default subnets selected, keep the default security group setting. **Cluster endpoint access: Public** → Next.
5. Logging: skip → Next. Add-ons: keep the defaults (CoreDNS, kube-proxy, Amazon VPC CNI) → Next → Next → **Create**.
6. Wait about 10 minutes until status is **Active**.

### 7b. The worker servers
1. Open the cluster → **Compute** tab → **Add node group**.
2. Name `shopflow-nodes`, Node IAM role `eks-node-role` → Next.
3. AMI **Amazon Linux 2023**, Instance type **t3.medium**, Desired / Minimum / Maximum size **2 / 2 / 2** → Next → keep default subnets → Next → **Create**.
4. Wait about 5 minutes until the node group is **Active**.

### 7c. Let Jenkins talk to the cluster
1. Cluster → **Access** tab → **IAM access entries** → **Create access entry**.
2. **IAM principal:** pick `jenkins-role`. Type **Standard** → Next.
3. Policy **AmazonEKSClusterAdminPolicy**, Access scope **Cluster** → Next → **Create**.

### 7d. Let the pods reach the database
1. Cluster → **Networking** tab → copy the **Cluster security group** ID (starts with `sg-`).
2. EC2 → **Security Groups** → open **`rds-sg`** → **Edit inbound rules** → add two rules:
   - Type **PostgreSQL** (5432), Source = the **cluster security group** ID you copied (lets the app reach the DB).
   - Type **PostgreSQL** (5432), Source = **`jenkins-sg`** (lets you peek at the tables from the Jenkins server).
3. Save rules.

---

## 8. Create the Jenkins server

1. Console → **EC2** → **Launch instance**.
2. Name `jenkins-server`. AMI **Amazon Linux 2023**. Instance type **t3.medium** (Jenkins needs memory; smaller ones struggle).
3. **Key pair:** *Proceed without a key pair* is fine (we use the browser Connect button).
4. **Network settings → Edit:** *Select existing security group* → **`jenkins-sg`**. Auto-assign public IP: **Enable**.
5. **Storage:** 20 GiB.
6. **Advanced details → IAM instance profile:** choose **`jenkins-role`**.
7. **Launch instance.** After about 1 minute, select it → **Connect** → **EC2 Instance Connect** → **Connect**. A black terminal opens in your browser.

### Install everything (copy these into that terminal, a block at a time)

```bash
# 1) Update and install Docker, Git, Java
sudo dnf upgrade -y
sudo dnf install -y docker git java-17-amazon-corretto fontconfig postgresql16
sudo systemctl enable --now docker

# 2) Install Jenkins
sudo wget -O /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/redhat-stable/jenkins.repo
sudo rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io-2023.key
sudo dnf install -y jenkins

# 3) Let Jenkins and you use Docker
sudo usermod -aG docker jenkins
sudo usermod -aG docker ec2-user
sudo systemctl enable --now jenkins

# 4) Install kubectl (the remote control for Kubernetes)
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -m 755 kubectl /usr/local/bin/kubectl
rm kubectl

# 5) Check
aws --version && kubectl version --client && docker --version
```

Then restart Jenkins so it picks up the Docker permission, and get its first-time password:

```bash
sudo systemctl restart jenkins
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

### Open Jenkins in your browser
1. In the EC2 console copy the instance's **Public IPv4 address**. Open `http://THAT_IP:8080`.
2. Paste the password → **Install suggested plugins** → create your admin user → Save and Finish.

---

## 9. First deployment

### 9a. Edit the Jenkinsfile if needed
In `Jenkinsfile` the top says `AWS_REGION = 'ap-south-1'` and `CLUSTER_NAME = 'shopflow-cluster'`. If you used different names, change them, then `git commit` and `git push`.

### 9b. Give Kubernetes the database password (once)
Back in the Jenkins server terminal (the EC2 Connect window):

```bash
git clone https://github.com/YOUR_NAME/shopflow.git
cd shopflow

aws eks update-kubeconfig --region ap-south-1 --name shopflow-cluster
kubectl get nodes        # should list 2 nodes with status Ready

kubectl apply -f k8s/00-namespace.yaml

kubectl create secret generic db-secret -n shopflow \
  --from-literal=DATABASE_URL='postgres://shopadmin:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/shopflow'
```

A **Secret** is Kubernetes' locked drawer for passwords. It is never in GitHub.
If `kubectl get nodes` says *Unauthorized*, redo Step 7c.

### 9c. Create the Jenkins job
1. Jenkins home → **New Item** → name `shopflow` → **Pipeline** → OK.
2. **Build Triggers:** tick **Poll SCM**, schedule `H/5 * * * *` (checks GitHub every ~5 minutes).
3. **Pipeline** section: Definition **Pipeline script from SCM** → SCM **Git** → Repository URL = your GitHub URL → Branch `*/main` → Script Path `Jenkinsfile`.
4. **Save** → **Build Now**.
5. Click the build number → **Console Output** to watch. Stages: *Get code → Run tests → Build images → Push images to ECR → Deploy to Kubernetes*. The first run takes about 5–8 minutes.

### 9d. Find your website
In the Jenkins server terminal:

```bash
kubectl -n shopflow get pods          # all should say Running (4 pods)
kubectl -n shopflow get svc frontend  # look at EXTERNAL-IP
```

The EXTERNAL-IP is a long address ending in `elb.amazonaws.com`. It may say `<pending>` for 2–3 minutes. Open `http://THAT_ADDRESS` in your browser. You should see the ShopFlow page with a green **"API and database connected"** badge.

---

## 10. Where nginx fits (and how to look at it)

nginx does three jobs, all written in `frontend/nginx.conf`:

1. **Serves the web page** (`index.html`).
2. **Forwards anything starting with `/api/`** to the backend. The browser only ever talks to nginx, so you don't need extra "CORS" settings.
3. **Answers `/healthz`** so Kubernetes can check nginx is alive.

The name `backend` in `proxy_pass http://backend:3000` is the Kubernetes Service name. Kubernetes' built-in address book turns it into the real pod addresses.

See the live config:
```bash
kubectl -n shopflow exec deploy/frontend -- cat /etc/nginx/conf.d/default.conf
kubectl -n shopflow logs deploy/frontend
```

---

## 11. Understand and test the database (the "I/O" part)

### The tables, in plain words
| Table | What it holds |
|---|---|
| `customers` | Who buys. Email must be unique |
| `products` | What is sold, price in paise, stock count. **Stock can never go below 0** |
| `orders` | One row per purchase. Status is `placed` or `cancelled` |
| `order_items` | The lines of each order. The **price at purchase time is frozen**, so later price changes don't rewrite history |
| `stock_movements` | A diary of every stock change (who, why, how much) |

### How reading and writing is kept safe
- **Transactions (all-or-nothing):** placing an order does lock products → check stock → create order → create lines → reduce stock → write diary. If any step fails, **everything is undone**.
- **Row locking (`FOR UPDATE`):** if 25 people grab the last 10 backpacks at the same moment, the database makes them queue. Exactly 10 succeed. Nobody gets an "oversold" item.
- **Locking in a fixed order:** prevents two orders from waiting on each other forever (a deadlock).
- **Rules inside the database** (`CHECK`, `UNIQUE`, `FOREIGN KEY`): even a buggy app cannot save a negative stock, a duplicate email, or an order for a customer who does not exist.
- **Indexes:** shortcuts, like a book's index, for "orders of this customer, newest first" and "lines of this order".
- **Paging:** product and order lists return at most 100 rows at a time.
- **Connection pool:** each backend pod keeps at most 10 open database connections, so 2 pods can't overwhelm the database.
- **Time limits:** a query running over 10 seconds is cancelled.
- **Safe SQL:** all values are passed as parameters (`$1`, `$2`), which blocks SQL injection.
- **Start-up lock:** when two pods start together, only one creates the tables.

### Try it yourself
In the Jenkins server terminal, set the address first:
```bash
URL=http://YOUR_ELB_ADDRESS
```

```bash
# List products
curl -s "$URL/api/products"

# Search
curl -s "$URL/api/products?q=lamp"

# Place an order (customer 1 buys 2 of product 1)
curl -s -X POST "$URL/api/orders" -H 'Content-Type: application/json' \
  -d '{"customer_id":1,"items":[{"product_id":1,"qty":2}]}'

# Ask for more than exists -> 409 "not enough stock"
curl -s -X POST "$URL/api/orders" -H 'Content-Type: application/json' \
  -d '{"customer_id":1,"items":[{"product_id":3,"qty":999}]}'

# Cancel order 1 -> stock goes back
curl -s -X POST "$URL/api/orders/1/cancel"
```

**The race test** (25 buyers at once for product 3, which has 10 in stock):
```bash
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/api/orders" \
    -H 'Content-Type: application/json' \
    -d '{"customer_id":1,"items":[{"product_id":3,"qty":1}]}' &
done | sort | uniq -c
```
Expected: **10 × `201`** (success) and **15 × `409`** (out of stock). Never more than 10 successes.

**Look inside the database:**
```bash
psql "host=YOUR_RDS_ENDPOINT user=shopadmin dbname=shopflow sslmode=require"
```
Then try:
```sql
\dt                                   -- list tables
SELECT id, name, stock FROM products ORDER BY id;
SELECT * FROM stock_movements ORDER BY id DESC LIMIT 10;
SELECT SUM(change) FROM stock_movements WHERE product_id = 3;   -- matches the stock drop
\q
```

---

## 12. Kubernetes things worth trying

```bash
kubectl -n shopflow get pods -o wide                        # where the pods run
kubectl -n shopflow scale deploy/backend --replicas=3       # add a third backend
kubectl -n shopflow delete pod -l app=backend --wait=false  # kill pods; watch Kubernetes recreate them
kubectl -n shopflow logs deploy/backend                     # read the backend's diary
kubectl -n shopflow rollout history deploy/backend          # past versions
kubectl -n shopflow rollout undo deploy/backend             # go back one version
```

**Change-and-redeploy practice:** edit the heading in `frontend/index.html`, `git commit`, `git push`. Within about 5 minutes Jenkins starts a build by itself and Kubernetes swaps in the new pods **without downtime** (the new ones must pass their health check before the old ones are removed).

---

## 13. Clean-up (do this the same day, in this order)

1. **Kubernetes first**, so the load balancer is removed. In the Jenkins terminal:
   ```bash
   kubectl delete namespace shopflow
   ```
   Wait 2 minutes. Check EC2 → **Load Balancers** is empty.
2. **EKS** → cluster → **Compute** → delete node group `shopflow-nodes`. When it's gone, delete the cluster.
3. **RDS** → `shopflow-db` → Actions → **Delete** (untick *final snapshot* and *automated backups*).
4. **EC2** → terminate `jenkins-server`. Check **Volumes** and **Elastic IPs** are empty.
5. **ECR** → delete both repositories.
6. **EC2 → Security Groups** → delete `rds-sg` and `jenkins-sg`.
7. **IAM** → delete the three roles (optional, they cost nothing).
8. Next day, look at **Billing** to confirm charges stopped.

---

## 14. If something goes wrong

| What you see | Likely reason | Fix |
|---|---|---|
| Jenkins page won't open | Your home IP changed, or port 8080 rule | Edit `jenkins-sg` rule 8080 → Source *My IP* again |
| Build: *permission denied ... docker.sock* | Jenkins not in Docker group yet | `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins` |
| Build: *Unable to locate credentials* | Instance has no role | EC2 → Instance → Actions → Security → **Modify IAM role** → `jenkins-role` |
| ECR push *denied* | Role lacks ECR policy, or repo names differ | Check Step 6 and the names `shopflow-backend` / `shopflow-frontend` |
| `kubectl`: *Unauthorized* | Missing access entry | Redo Step 7c |
| Pod `ImagePullBackOff` | Wrong region/account or node role lacks ECR read | Check `eks-node-role` has `AmazonEC2ContainerRegistryReadOnly`; run `kubectl -n shopflow describe pod POD_NAME` |
| Pod `CrashLoopBackOff` and log says *DB not ready* | Wrong password/endpoint, or `rds-sg` rule missing | Run `kubectl -n shopflow logs deploy/backend`; recheck Step 7d; recreate the secret (delete it, create again, then `kubectl -n shopflow rollout restart deploy/backend`) |
| Pod `Pending` | Nodes not ready or full | `kubectl get nodes`; wait or check the node group |
| EXTERNAL-IP stays `<pending>` over 5 minutes | Load balancer still being created | `kubectl -n shopflow describe svc frontend` and read the *Events* |
| Website shows **502 Bad Gateway** | Backend pods not ready | `kubectl -n shopflow get pods`; check backend logs |
| Badge says "API unreachable" | Same as above, or backend crashed | Same as above |

When you get stuck, copy the exact error message and ask. The first red line in the output is usually the real clue.

---

## 15. What to learn next
- Move the website to **HTTPS** with an Ingress/ALB and a free ACM certificate.
- Store the DB password in **AWS Secrets Manager**.
- Add **CloudWatch** logs and alarms.
- Describe all of this as code with **Terraform**.
- Add an automatic **Horizontal Pod Autoscaler** (more pods when busy).
